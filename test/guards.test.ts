import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { buildTui } from "../scripts/build-tui"
import { remove } from "../src/catalog"
import { formDelivery, type Client } from "../src/delivery"
import { update } from "../src/settings"
import { check as checkUpdates, claimAnnouncement, newer } from "../src/updates"
import { VERSION } from "../src/version"

describe("release safety guards", () => {
  test("rejects model paths outside the model directory", () => {
    expect(() => remove("../../escape")).toThrow("invalid model name")
  })

  test("rejects decode settings that could stall chunking", async () => {
    await expect(update({ ceilingSec: 0 })).rejects.toThrow("invalid setting")
  })

  test("adopts an identical open draft instead of duplicating it", async () => {
    let creates = 0
    let cancels = 0
    const client = {
      session: {
        form: {
          list: async () => [{ id: "form-1", metadata: { source: "opencode-voice" } }],
          get: async () => ({ id: "form-1", fields: [{ default: "same draft" }] }),
          cancel: async () => void cancels++,
          create: async () => {
            creates++
            return { id: "form-2" }
          },
        },
        prompt: async () => {},
      },
    } satisfies Client
    const delivery = formDelivery(client, { save: async () => {}, clear: async () => {} })

    await delivery.push("session-1", "same draft")

    expect(creates).toBe(0)
    expect(cancels).toBe(0)
    expect(delivery.owns("form-1")).toBeTrue()
  })

  test("leaves an existing draft untouched when it cannot be read", async () => {
    let creates = 0
    const client = {
      session: {
        form: {
          list: async () => [{ id: "form-1", metadata: { source: "opencode-voice" } }],
          get: async () => {
            throw new Error("transport")
          },
          cancel: async () => {},
          create: async () => {
            creates++
            return { id: "form-2" }
          },
        },
        prompt: async () => {},
      },
    } satisfies Client
    const delivery = formDelivery(client, { save: async () => {}, clear: async () => {} })

    await expect(delivery.push("session-1", "new take")).rejects.toThrow("transport")
    expect(creates).toBe(0)
  })

  test("published panel is Solid-compiled, not generic JSX (npm installs would freeze)", async () => {
    const out = await buildTui(mkdtempSync(`${tmpdir()}/voice-build-`))
    const code = await Bun.file(out).text()
    expect(code).not.toMatch(/\bjsxDEV?\(/)
    expect(code).toMatch(/\bget when\(\)/)
    expect(code).toMatch(/from "@opentui\/solid"/)
    expect(code).toMatch(/from "@opencode\/plugin\/tui"/)
  }, 30_000)

  test("only the take's own push carries its custody token to the server", async () => {
    const saves: Array<string | undefined> = []
    const client = {
      session: {
        form: {
          list: async () => [],
          get: async () => ({ id: "none" }),
          cancel: async () => {},
          create: async () => ({ id: "form-1" }),
        },
        prompt: async () => {},
      },
    } satisfies Client
    const delivery = formDelivery(client, { save: async (_text, take) => void saves.push(take), clear: async () => {} })

    await delivery.push("session-1", "fresh take", "take-token")
    await delivery.restoreLast() // re-raise: must not acknowledge any audio
    await delivery.push("session-1", "recovered old draft") // recovery of a saved draft

    expect(saves).toEqual(["take-token", undefined, undefined])
  })

  test("compares stable release versions without treating malformed input as an update", () => {
    expect(newer("0.0.7", "0.0.6")).toBeTrue()
    expect(newer("0.0.6", "0.0.6")).toBeFalse()
    expect(newer("0.0.5", "0.0.6")).toBeFalse()
    expect(newer("0.0.7-beta.1", "0.0.6")).toBeFalse()
  })

  test("caches bounded update metadata and announces a release only once", async () => {
    const root = mkdtempSync(`${tmpdir()}/voice-update-`)
    const oldData = process.env.XDG_DATA_HOME
    const oldFetch = globalThis.fetch
    process.env.XDG_DATA_HOME = root
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        version: "999.0.0",
        opencodeVoice: { releases: { "999.0.0": ["New feature\nwith detail", 42] } },
      }), { status: 200 })) as unknown as typeof fetch
    try {
      const info = await checkUpdates(true)
      expect(info).toEqual({
        installed: VERSION,
        latest: "999.0.0",
        available: true,
        releases: [{ version: "999.0.0", notes: ["New feature with detail"] }],
      })
      expect(await claimAnnouncement("999.0.0")).toBeTrue()
      expect(await claimAnnouncement("999.0.0")).toBeFalse()
    } finally {
      globalThis.fetch = oldFetch
      if (oldData === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = oldData
      rmSync(root, { recursive: true, force: true })
    }
  })
})
