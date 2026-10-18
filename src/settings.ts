/**
 * Every tunable lives here — nothing is edited in source.
 *
 * The server half owns the values (single source of truth, persisted as a
 * full-snapshot JSON file in the data dir — see below); the TUI reads and
 * writes them over RPC.
 * `recommended` is shown next to each row in the menu so a drifted value is
 * always visible and restorable.
 */

import { cpus } from "node:os"

export type SettingKind = "string" | "number" | "boolean" | "choice"

export interface SettingSpec {
  key: string
  label: string
  kind: SettingKind
  group:
    | "Transcription"
    | "Audio"
    | "Behavior"
    | "Shortcuts"
    | "Decoding"
    | "Voice detection (VAD)"
    | "Level meter"
    | "Interface"
    | "Debug"
  recommended: string | number | boolean
  choices?: string[]
  hint?: string
}

export const SPECS: SettingSpec[] = [
  // --- main page: the settings you actually touch ---
  { key: "model", label: "Model", kind: "string", group: "Transcription", recommended: "small.en" },
  { key: "language", label: "Language", kind: "string", group: "Transcription", recommended: "auto" },
  { key: "device", label: "Input device", kind: "string", group: "Audio", recommended: "default" },
  {
    key: "recorder",
    label: "Recorder",
    kind: "choice",
    group: "Audio",
    recommended: "auto",
    choices: ["auto", "pw-record", "arecord", "ffmpeg"],
    hint: "which capture tool records the mic",
  },
  {
    key: "residency",
    label: "Model residency",
    kind: "choice",
    group: "Behavior",
    recommended: "15 min",
    choices: ["always loaded", "5 min", "15 min", "30 min", "60 min", "unload after each take"],
    hint: "how long the model stays in RAM between takes",
  },
  {
    key: "notifications",
    label: "Notifications",
    kind: "choice",
    group: "Behavior",
    recommended: "errors only",
    choices: ["all", "errors only", "none"],
    hint: "toast noise; the panel and the form are the real feedback",
  },
  {
    key: "updateCheck",
    label: "Check for updates",
    kind: "boolean",
    group: "Behavior",
    recommended: true,
    hint: "daily npm metadata check; only informs, never installs",
  },
  {
    key: "safetyNet",
    label: "Safety net",
    kind: "boolean",
    group: "Behavior",
    recommended: true,
    hint: "keep the last take on disk (audio, then draft) until it is delivered",
  },
  {
    key: "deliveryMode",
    label: "Delivery",
    kind: "choice",
    group: "Behavior",
    recommended: "queue",
    choices: ["queue", "steer"],
    hint: "queue = send after the current turn · steer = inject into it",
  },
  { key: "recordKey", label: "Record key", kind: "string", group: "Shortcuts", recommended: "f9" },
  { key: "settingsKey", label: "Settings key", kind: "string", group: "Shortcuts", recommended: "ctrl+alt+v" },
  { key: "restoreKey", label: "Recovery key", kind: "string", group: "Shortcuts", recommended: "ctrl+f9", hint: "restores a saved draft or retries a failed take; empty = palette only" },

  // --- advanced page: defaults are tuned, change only if you know why ---
    // cores-2 leaves headroom for opencode's server + UI threads
  { key: "threads", label: "Engine threads", kind: "number", group: "Decoding", recommended: Math.max(1, cpus().length - 2), hint: "default: machine cores - 2" },
  { key: "ceilingSec", label: "Decode ceiling s", kind: "number", group: "Decoding", recommended: 25, hint: "max seconds per decode chunk; engine hard limit is 30" },
  { key: "splitSearchSec", label: "Split search s", kind: "number", group: "Decoding", recommended: 4, hint: "pause-hunting window for forced splits" },
  {
    key: "filterAnnotations",
    label: "Filter noise annotations",
    kind: "choice",
    group: "Decoding",
    recommended: "whole lines only",
    choices: ["full", "whole lines only", "off"],
    hint: "(buzzing)/[BLANK_AUDIO] lines; full also strips markers inside lines",
  },
  { key: "vadEnabled", label: "VAD enabled", kind: "boolean", group: "Voice detection (VAD)", recommended: true, hint: "pause detection: splits takes into lines, skips silence" },
  { key: "vadThreshold", label: "VAD threshold", kind: "number", group: "Voice detection (VAD)", recommended: 0.5, hint: "0..1 — higher = stricter about what counts as speech" },
  { key: "vadMinSilenceSec", label: "VAD min silence s", kind: "number", group: "Voice detection (VAD)", recommended: 0.4, hint: "line-break sensitivity" },
  { key: "vadMinSpeechSec", label: "VAD min speech s", kind: "number", group: "Voice detection (VAD)", recommended: 0.25, hint: "shorter sounds are ignored as noise" },
  { key: "vadMaxSpeechSec", label: "VAD max speech s", kind: "number", group: "Voice detection (VAD)", recommended: 120, hint: "safety valve; keep ABOVE decode ceiling — pause-aware splitting handles the 30s engine limit" },
  {
    key: "meterStyle",
    label: "Meter style",
    kind: "choice",
    group: "Level meter",
    recommended: "live",
    choices: ["live", "animated", "off"],
    hint: "recording bars: live mic levels · decorative ripple · none",
  },
  { key: "meterGain", label: "Meter sensitivity", kind: "number", group: "Level meter", recommended: 6, hint: "recording level bars: higher = quiet speech shows taller" },
  { key: "meterFloor", label: "Meter noise floor", kind: "number", group: "Level meter", recommended: 0.015, hint: "quieter than this, the level bars stay flat (room noise)" },
  { key: "meterIntervalMs", label: "Meter refresh ms", kind: "number", group: "Level meter", recommended: 150, hint: "update rate of the recording level bars" },
  { key: "meterWidth", label: "Meter width", kind: "number", group: "Level meter", recommended: 16, hint: "recording level bars: width in characters (capped to panel)" },
  { key: "statsIntervalMs", label: "C:/R: border stats refresh ms", kind: "number", group: "Interface", recommended: 2000, hint: "whole opencode server usage" },
  { key: "formTitle", label: "Form title", kind: "string", group: "Interface", recommended: "🎤 submit sends · esc discards", hint: "title of the proofread form raised in the chat" },
  { key: "toastInfoMs", label: "Toast info ms", kind: "number", group: "Interface", recommended: 5000, hint: "how long info popups stay" },
  { key: "toastErrorMs", label: "Toast error ms", kind: "number", group: "Interface", recommended: 10000, hint: "how long error popups stay" },
  { key: "debugLog", label: "Debug logging", kind: "boolean", group: "Debug", recommended: false, hint: "verbose lines in the voice log" },
]

/** Groups shown behind the "Advanced…" row (second menu page). */
export const ADVANCED_GROUPS: string[] = ["Decoding", "Voice detection (VAD)", "Level meter", "Interface", "Debug"]

export type Settings = Record<string, string | number | boolean>

export const DEFAULTS: Settings = Object.fromEntries(SPECS.map((s) => [s.key, s.recommended]))

const NUMBER_BOUNDS: Record<string, [number, number]> = {
  threads: [1, 256],
  ceilingSec: [1, 29],
  splitSearchSec: [0, 29],
  vadThreshold: [0, 1],
  vadMinSilenceSec: [0.01, 60],
  vadMinSpeechSec: [0.01, 60],
  vadMaxSpeechSec: [1, 3600],
  meterGain: [0.01, 1000],
  meterFloor: [0, 1],
  meterIntervalMs: [50, 60_000],
  meterWidth: [4, 1000],
  statsIntervalMs: [250, 60_000],
  toastInfoMs: [0, 600_000],
  toastErrorMs: [0, 600_000],
}

function validValue(spec: SettingSpec, value: unknown): string | number | boolean | undefined {
  if (spec.key === "filterAnnotations" && typeof value === "boolean") return value ? "full" : "off"
  if (spec.kind === "boolean") {
    if (typeof value === "boolean") return value
    if (value === "true" || value === "false") return value === "true"
    return undefined
  }
  if (spec.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined
    const [min, max] = NUMBER_BOUNDS[spec.key] ?? [-Number.MAX_VALUE, Number.MAX_VALUE]
    return value >= min && value <= max ? value : undefined
  }
  if (typeof value !== "string" || value.length > 2048) return undefined
  if (spec.kind === "choice" && !spec.choices?.includes(value)) return undefined
  if (spec.key === "model" && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === ".."))
    return undefined
  return value
}

function normalized(snapshot: Record<string, unknown>): Settings {
  return Object.fromEntries(
    SPECS.map((spec) => [spec.key, validValue(spec, snapshot[spec.key]) ?? spec.recommended]),
  )
}

export function dataDir(): string {
  return `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/opencode-voice`
}

// Persistence: a plain JSON file in the data dir. opencode's plugin storage
// is location-scoped and the server half loads once PER LOCATION — two
// instances, two stores, settings seemingly "lost" depending on which
// instance answers. One file on disk has no such ambiguity, and it joins the
// delete-dir-equals-uninstall story.
const settingsFile = () => `${dataDir()}/settings.json`

let cache: Settings = { ...DEFAULTS }

export function current(): Settings {
  return cache
}

export function num(key: string): number {
  const v = cache[key]
  return typeof v === "number" ? v : Number(v)
}

export function str(key: string): string {
  return String(cache[key])
}

export function bool(key: string): boolean {
  return cache[key] === true || cache[key] === "true"
}

/** Worker-side: adopt a settings snapshot sent from the main thread. */
export function apply(snapshot: Settings): void {
  cache = normalized(snapshot)
}

export async function hydrate(): Promise<Settings> {
  try {
    const stored = (await Bun.file(settingsFile()).json()) as Record<string, unknown>
    cache = normalized(stored)
  } catch {
    cache = { ...DEFAULTS } // no file yet, or unreadable: recommended values
  }
  return cache
}

async function persist(): Promise<void> {
  // the FULL snapshot, not drift: if a plugin update changes a recommended
  // value, the user's effective settings must not silently change with it
  await Bun.write(settingsFile(), JSON.stringify(cache, null, 2))
}

export async function update(patch: Settings): Promise<Settings> {
  const accepted: Settings = {}
  for (const [key, value] of Object.entries(patch)) {
    const spec = SPECS.find((entry) => entry.key === key)
    const valid = spec && validValue(spec, value)
    if (!spec || valid === undefined) throw new Error(`invalid setting: ${key}`)
    accepted[key] = valid
  }
  cache = { ...cache, ...accepted }
  await persist()
  return cache
}

export async function reset(): Promise<Settings> {
  cache = { ...DEFAULTS }
  await persist()
  return cache
}
