/**
 * Update awareness: reads this package's public npm `/latest` metadata at most
 * daily, caches it in updates.json, and owns the one-at-a-time announcement
 * lease so several terminals show a new release exactly once. Never installs
 * anything. Sends nothing but the request itself.
 */
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dataDir } from "./settings"
import { withDirLock, writeAtomic } from "./fsutil"
import { VERSION, cleanReleases, compareVersions, newer, parts } from "./version"

const PACKAGE = "@juliuskb/opencode-voice"
const REGISTRY = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}/latest`
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000
const FAILURE_BACKOFF_MS = 60 * 60 * 1000
const CLAIM_LEASE_MS = 30_000
const MAX_RESPONSE_BYTES = 1024 * 1024

export type UpdateOutcome = "checked" | "cached" | "disabled" | "failed"

export type UpdateInfo = {
  installed: string
  latest: string
  available: boolean
  releases: Array<{ version: string; notes: string[] }>
  enabled: boolean
  outcome: UpdateOutcome
}

type UpdateState = {
  epoch?: number
  checkedAt?: number
  attemptedAt?: number
  latest?: string
  releases?: Record<string, string[]>
  announced?: string
  promptedVersion?: string
  promptedAt?: number
  promptedToken?: string
}

const stateFile = () => `${dataDir()}/updates.json`
const lockDir = () => `${dataDir()}/updates.lock`
// one request at a time per server; a forced (manual) check must not be
// answered by an automatic one that may settle for the cached result
let inFlight: { task: Promise<UpdateInfo>; forced: boolean } | null = null

const withLock = <T>(fn: () => T | Promise<T>) => withDirLock(lockDir(), "update state", fn)

function readState(): UpdateState {
  try {
    const value = JSON.parse(readFileSync(stateFile(), "utf8")) as UpdateState
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

function writeState(state: UpdateState): void {
  writeAtomic(stateFile(), `${JSON.stringify(state, null, 2)}\n`)
}

export function status(outcome: UpdateOutcome, enabled: boolean): UpdateInfo {
  const state = readState()
  const latest = typeof state.latest === "string" ? state.latest : ""
  return {
    installed: VERSION,
    latest,
    available: newer(latest),
    releases: Object.entries(cleanReleases(state.releases))
      .filter(([version]) => newer(version) && !newer(version, latest))
      .sort(([a], [b]) => compareVersions(b, a))
      .map(([version, notes]) => ({ version, notes })),
    enabled,
    outcome,
  }
}

async function readResponseLimited(response: Response): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error("registry response too large")
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

export async function claimAnnouncement(version: string): Promise<string | null> {
  if (!newer(version)) return null
  return withLock(() => {
    const state = readState()
    if (state.latest !== version) return null
    if (state.announced && !newer(version, state.announced)) return null
    if (state.promptedToken && state.promptedAt && Date.now() - state.promptedAt < CLAIM_LEASE_MS) return null
    const token = randomUUID()
    writeState({ ...state, promptedVersion: version, promptedAt: Date.now(), promptedToken: token })
    return token
  })
}

export async function acknowledgeAnnouncement(version: string): Promise<void> {
  if (!newer(version)) return
  await withLock(() => {
    const state = readState()
    if (state.latest !== version) return
    if (!state.announced || newer(version, state.announced)) writeState({ ...state, announced: version })
  })
}

export async function renewAnnouncement(version: string, token: string): Promise<boolean> {
  return withLock(() => {
    const state = readState()
    if (state.promptedVersion !== version || state.promptedToken !== token) return false
    writeState({ ...state, promptedAt: Date.now() })
    return true
  })
}

export async function settleAnnouncement(version: string, token: string, acknowledged: boolean): Promise<boolean> {
  return withLock(() => {
    const state = readState()
    if (state.promptedVersion !== version || state.promptedToken !== token) return false
    const next = { ...state }
    delete next.promptedVersion
    delete next.promptedAt
    delete next.promptedToken
    if (acknowledged && (!state.announced || newer(version, state.announced))) next.announced = version
    writeState(next)
    return true
  })
}

export async function clear(): Promise<void> {
  await withLock(() => {
    const epoch = (readState().epoch ?? 0) + 1
    writeState({ epoch })
  })
  inFlight = null
}

export function check(enabled: boolean, force = false): Promise<UpdateInfo> {
  if (!enabled && !force) return Promise.resolve(status("disabled", false))
  if (inFlight && (inFlight.forced || !force)) return inFlight.task
  const task = (async () => {
    const now = Date.now()
    const epoch = await withLock(() => {
      const state = readState()
      if (!force && state.checkedAt && now - state.checkedAt < SUCCESS_TTL_MS) return null
      if (!force && state.attemptedAt && now - state.attemptedAt < FAILURE_BACKOFF_MS) return null
      writeState({ ...state, attemptedAt: now })
      return state.epoch ?? 0
    })
    if (epoch === null) return status("cached", enabled)
    try {
      const response = await fetch(REGISTRY, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const declaredSize = Number(response.headers.get("content-length") ?? 0)
      if (declaredSize > MAX_RESPONSE_BYTES) throw new Error("registry response too large")
      const text = await readResponseLimited(response)
      const body = JSON.parse(text) as {
        version?: unknown
        opencodeVoice?: { releases?: unknown }
      }
      if (typeof body.version !== "string" || !parts(body.version)) throw new Error("invalid registry version")
      await withLock(() => {
        const state = readState()
        if ((state.epoch ?? 0) !== epoch) return
        const next: UpdateState = {
          ...state,
          checkedAt: Date.now(),
          latest: body.version as string,
          releases: cleanReleases(body.opencodeVoice?.releases),
        }
        delete next.attemptedAt // the failure backoff applies only after a failure
        writeState(next)
      })
    } catch {
      // Updates are optional. The failure is reported through `outcome`:
      // automatic callers stay silent, a manual check tells the user.
      return status("failed", enabled)
    }
    return status("checked", enabled)
  })()
  const entry = { task, forced: force }
  inFlight = entry
  const clearInFlight = () => {
    if (inFlight === entry) inFlight = null
  }
  void task.then(clearInFlight, clearInFlight)
  return task
}
