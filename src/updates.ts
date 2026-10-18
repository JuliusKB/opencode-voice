import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dataDir } from "./settings"
import { VERSION } from "./version"

const PACKAGE = "@juliuskb/opencode-voice"
const REGISTRY = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}/latest`
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000
const FAILURE_BACKOFF_MS = 60 * 60 * 1000

export type UpdateInfo = {
  installed: string
  latest: string
  available: boolean
  releases: Array<{ version: string; notes: string[] }>
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
  promptedRun?: string
}

const stateFile = () => `${dataDir()}/updates.json`
const lockDir = () => `${dataDir()}/updates.lock`
const RUN_ID = randomUUID()
let inFlight: Promise<UpdateInfo> | null = null

async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  mkdirSync(dataDir(), { recursive: true })
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lockDir())
      break
    } catch {
      try {
        if (Date.now() - statSync(lockDir()).mtimeMs > 15_000) rmSync(lockDir(), { recursive: true, force: true })
      } catch {
        // lock disappeared between checks
      }
      if (attempt >= 100) throw new Error("update state is locked")
      await Bun.sleep(20)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lockDir(), { recursive: true, force: true })
  }
}

function readState(): UpdateState {
  try {
    const value = JSON.parse(readFileSync(stateFile(), "utf8")) as UpdateState
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

function writeState(state: UpdateState): void {
  mkdirSync(dataDir(), { recursive: true })
  const tmp = `${stateFile()}.tmp-${randomUUID()}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, stateFile())
}

function parts(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function newer(candidate: string, installed = VERSION): boolean {
  const a = parts(candidate)
  const b = parts(installed)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

function cleanNotes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim())
    .filter(Boolean)
}

function cleanReleases(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([version]) => parts(version) !== null)
      .map(([version, notes]) => [version, cleanNotes(notes)])
      .filter(([, notes]) => notes.length > 0)
  )
}

export function status(): UpdateInfo {
  const state = readState()
  const latest = typeof state.latest === "string" ? state.latest : ""
  return {
    installed: VERSION,
    latest,
    available: newer(latest),
    releases: Object.entries(cleanReleases(state.releases))
      .filter(([version]) => newer(version) && !newer(version, latest))
      .sort(([a], [b]) => newer(a, b) ? -1 : newer(b, a) ? 1 : 0)
      .map(([version, notes]) => ({ version, notes })),
  }
}

export async function claimAnnouncement(version: string): Promise<boolean> {
  if (!newer(version)) return false
  return withLock(() => {
    const state = readState()
    if (state.announced === version) return false
    if (state.promptedVersion === version && state.promptedRun === RUN_ID) return false
    if (state.promptedVersion === version && state.promptedAt && Date.now() - state.promptedAt < 30_000) return false
    writeState({ ...state, promptedVersion: version, promptedAt: Date.now(), promptedRun: RUN_ID })
    return true
  })
}

export async function settleAnnouncement(version: string, acknowledged: boolean): Promise<void> {
  await withLock(() => {
    const state = readState()
    if (acknowledged) writeState({ ...state, announced: version })
    else {
      const next = { ...state }
      delete next.promptedVersion
      delete next.promptedAt
      delete next.promptedRun
      writeState(next)
    }
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
  if (!enabled) return Promise.resolve(status())
  if (inFlight) return inFlight
  const task = (async () => {
    const now = Date.now()
    const epoch = await withLock(() => {
      const state = readState()
      if (!force && state.checkedAt && now - state.checkedAt < SUCCESS_TTL_MS) return null
      if (!force && state.attemptedAt && now - state.attemptedAt < FAILURE_BACKOFF_MS) return null
      writeState({ ...state, attemptedAt: now })
      return state.epoch ?? 0
    })
    if (epoch === null) return status()
    try {
      const response = await fetch(REGISTRY, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as {
        version?: unknown
        opencodeVoice?: { releases?: unknown }
      }
      if (typeof body.version !== "string" || !parts(body.version)) throw new Error("invalid registry version")
      await withLock(() => {
        const state = readState()
        if ((state.epoch ?? 0) !== epoch) return
        writeState({
          ...state,
          checkedAt: Date.now(),
          latest: body.version as string,
          releases: cleanReleases(body.opencodeVoice?.releases),
        })
      })
    } catch {
      // Updates are optional: offline startup and registry failures stay silent.
    }
    return status()
  })()
  inFlight = task
  void task.finally(() => {
    if (inFlight === task) inFlight = null
  })
  return task
}
