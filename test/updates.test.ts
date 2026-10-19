/**
 * Update awareness, exercised against a throwaway data dir and a fake npm
 * registry. This is the permanent stand-in for "publish a newer version and
 * watch an installed client": every state transition the dialogs rely on is
 * driven here without network or a second machine.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dataDir, persistedBool, update } from "../src/settings"
import {
  acknowledgeAnnouncement,
  check,
  claimAnnouncement,
  clear,
  renewAnnouncement,
  settleAnnouncement,
  status,
} from "../src/updates"
import { RELEASES, VERSION, cleanReleases, compareVersions, newer } from "../src/version"

type Registry = () => Promise<Response>

/** Run `fn` with a fresh data dir and `registry` standing in for npm; restore everything after. */
async function withFixture(registry: Registry, fn: (calls: () => number) => Promise<void>): Promise<void> {
  const root = mkdtempSync(`${tmpdir()}/voice-updates-`)
  const oldData = process.env.XDG_DATA_HOME
  const oldFetch = globalThis.fetch
  let calls = 0
  process.env.XDG_DATA_HOME = root
  globalThis.fetch = (async () => {
    calls++
    return registry()
  }) as unknown as typeof fetch
  try {
    await fn(() => calls)
  } finally {
    globalThis.fetch = oldFetch
    if (oldData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldData
    rmSync(root, { recursive: true, force: true })
  }
}

const manifest = (version: string, releases: Record<string, unknown>): Registry => () =>
  Promise.resolve(new Response(JSON.stringify({ version, opencodeVoice: { releases } }), { status: 200 }))

const NEW = "999.0.0"
const newRelease = manifest(NEW, { [NEW]: ["New feature"] })

const stateFile = () => `${dataDir()}/updates.json`
const readState = () => JSON.parse(readFileSync(stateFile(), "utf8")) as Record<string, unknown>
const patchState = (patch: Record<string, unknown>) => writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }))

/** A registry whose first response waits until `release()` is called. */
function gatedRegistry(): { registry: Registry; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  return {
    registry: async () => {
      if (first) {
        first = false
        await gate
      }
      return newRelease()
    },
    release,
  }
}

describe("version helpers", () => {
  test("compares stable versions only", () => {
    expect(newer("0.0.7", "0.0.6")).toBeTrue()
    expect(newer("0.0.6", "0.0.6")).toBeFalse()
    expect(newer("0.0.5", "0.0.6")).toBeFalse()
    expect(newer("0.0.7-beta.1", "0.0.6")).toBeFalse()
    expect(["0.0.10", "0.1.0", "0.0.9"].sort(compareVersions)).toEqual(["0.0.9", "0.0.10", "0.1.0"])
  })

  test("cleans release notes: stable keys, string notes, one line each", () => {
    expect(cleanReleases({ "1.0.0": ["a\nb", 42, "  "], "1.0.0-rc.1": ["x"], bad: ["y"], "2.0.0": [] }))
      .toEqual({ "1.0.0": ["a b"] })
    expect(cleanReleases(null)).toEqual({})
  })

  test("the package carries release notes for its own version (publish guard)", () => {
    expect(RELEASES[VERSION]?.length ?? 0).toBeGreaterThan(0)
  })
})

describe("update checks", () => {
  test("disabled automatic check makes no request; a forced check does but stays disabled", async () => {
    await withFixture(newRelease, async (calls) => {
      expect((await check(false)).outcome).toBe("disabled")
      expect(calls()).toBe(0)
      const forced = await check(false, true)
      expect(forced.outcome).toBe("checked")
      expect(forced.enabled).toBeFalse()
      expect(forced.available).toBeTrue()
      expect(calls()).toBe(1)
    })
  })

  test("a successful check is reused for a day", async () => {
    await withFixture(newRelease, async (calls) => {
      expect((await check(true)).outcome).toBe("checked")
      expect((await check(true)).outcome).toBe("cached")
      expect(calls()).toBe(1)
      patchState({ checkedAt: Date.now() - 25 * 60 * 60 * 1000 })
      expect((await check(true)).outcome).toBe("checked")
      expect(calls()).toBe(2)
    })
  })

  test("a failed check backs off for an hour and reports failure, not currency", async () => {
    let offline = true
    await withFixture(() => (offline ? Promise.reject(new Error("offline")) : newRelease()), async (calls) => {
      const failed = await check(true, true)
      expect(failed.outcome).toBe("failed")
      expect(failed.available).toBeFalse()
      offline = false
      expect((await check(true)).outcome).toBe("cached") // inside the backoff: no request
      expect(calls()).toBe(1)
      patchState({ attemptedAt: Date.now() - 2 * 60 * 60 * 1000 })
      expect((await check(true)).outcome).toBe("checked")
      expect(calls()).toBe(2)
    })
  })

  test("lists only releases newer than installed up to latest, newest first", async () => {
    const releases = { "0.0.1": ["old"], "998.0.0": ["mid"], [NEW]: ["top"], "1000.0.0": ["beyond latest"] }
    await withFixture(manifest(NEW, releases), async () => {
      expect(await check(true, true)).toEqual({
        installed: VERSION,
        latest: NEW,
        available: true,
        releases: [
          { version: NEW, notes: ["top"] },
          { version: "998.0.0", notes: ["mid"] },
        ],
        enabled: true,
        outcome: "checked",
      })
    })
    await withFixture(manifest("0.0.1", { "0.0.1": ["old"] }), async () => {
      const info = await check(true, true)
      expect(info.available).toBeFalse()
      expect(info.releases).toEqual([])
    })
  })

  test("rejects oversized or malformed registry metadata", async () => {
    await withFixture(manifest(NEW, { [NEW]: ["x".repeat(1024 * 1024 + 1)] }), async () => {
      const info = await check(true, true)
      expect(info.outcome).toBe("failed")
      expect(info.releases).toEqual([])
    })
    await withFixture(() => Promise.resolve(new Response(JSON.stringify({ version: "1.0.0-beta" }), { status: 200 })), async () => {
      expect((await check(true, true)).outcome).toBe("failed")
    })
    await withFixture(() => Promise.resolve(new Response("nope", { status: 500 })), async () => {
      expect((await check(true, true)).outcome).toBe("failed")
    })
  })

  test("clearing update state discards the result of a check already in flight", async () => {
    const gated = gatedRegistry()
    await withFixture(gated.registry, async () => {
      const pending = check(true)
      await Bun.sleep(20) // past the lock, waiting on the registry
      await clear()
      gated.release()
      expect((await pending).available).toBeFalse()
      expect(status("cached", true).latest).toBe("")
    })
  })

  test("a manual check is not answered by a pending automatic one", async () => {
    const gated = gatedRegistry()
    await withFixture(gated.registry, async (calls) => {
      const automatic = check(true)
      await Bun.sleep(20)
      const manual = check(true, true)
      await Bun.sleep(20)
      expect(calls()).toBe(2)
      gated.release()
      expect((await manual).outcome).toBe("checked")
      expect((await automatic).outcome).toBe("checked")
    })
  })

  test("an abandoned lock is cleared instead of failing every caller", async () => {
    await withFixture(newRelease, async () => {
      const lock = `${dataDir()}/updates.lock`
      mkdirSync(lock, { recursive: true })
      const old = (Date.now() - 10_000) / 1000
      utimesSync(lock, old, old)
      expect((await check(true, true)).outcome).toBe("checked")
    })
  })
})

describe("announcements", () => {
  test("Got it suppresses the release; Remind me later repeats it; a lapsed lease can be taken over", async () => {
    await withFixture(newRelease, async () => {
      await check(true, true)
      // first terminal claims; a second terminal cannot while the lease lives
      const token = await claimAnnouncement(NEW)
      expect(token).toBeTruthy()
      expect(await claimAnnouncement(NEW)).toBeNull()
      expect(await renewAnnouncement(NEW, token!)).toBeTrue()
      expect(await renewAnnouncement(NEW, "stale")).toBeFalse()
      // Remind me later: the claim is released, the next startup may prompt again
      expect(await settleAnnouncement(NEW, token!, false)).toBeTrue()
      const again = await claimAnnouncement(NEW)
      expect(again).toBeTruthy()
      // the claimant died: once the lease lapses another terminal takes over
      patchState({ promptedAt: Date.now() - 31_000 })
      const takeover = await claimAnnouncement(NEW)
      expect(takeover).toBeTruthy()
      expect(await settleAnnouncement(NEW, again!, true)).toBeFalse() // the dead claim's token no longer counts
      expect(await settleAnnouncement(NEW, takeover!, true)).toBeTrue()
      // Got it: never prompted again for this version, but the panel still knows about it
      expect(await claimAnnouncement(NEW)).toBeNull()
      expect(status("cached", true).available).toBeTrue()
    })
  })

  test("a manual alert acknowledges without a claim", async () => {
    await withFixture(newRelease, async () => {
      await check(true, true)
      await acknowledgeAnnouncement(NEW)
      expect(await claimAnnouncement(NEW)).toBeNull()
    })
  })

  test("a version the registry never reported cannot be claimed", async () => {
    await withFixture(newRelease, async () => {
      await check(true, true)
      expect(await claimAnnouncement("998.0.0")).toBeNull()
      expect(await claimAnnouncement("0.0.1")).toBeNull()
    })
  })
})

describe("consent", () => {
  test("defaults on for a first run but fails closed for corrupt settings", async () => {
    await withFixture(newRelease, async () => {
      expect(persistedBool("updateCheck")).toBeTrue()
      mkdirSync(dataDir(), { recursive: true })
      writeFileSync(`${dataDir()}/settings.json`, "not json")
      expect(persistedBool("updateCheck")).toBeFalse()
      await update({ safetyNet: false })
      expect(persistedBool("updateCheck")).toBeFalse()
      writeFileSync(`${dataDir()}/settings.json`, JSON.stringify({ safetyNet: true }))
      expect(persistedBool("updateCheck")).toBeTrue()
    })
  })
})
