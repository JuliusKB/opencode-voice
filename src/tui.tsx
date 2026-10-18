/** @jsxImportSource @opentui/solid */
// The pragma is load-bearing: when installed from npm, this file is
// transpiled by the host's Bun, which ignores tsconfig.json inside
// node_modules and would otherwise look for react/jsx-dev-runtime.
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { Voice } from "./rpc"
import { formDelivery, type Client } from "./delivery"
import { ADVANCED_GROUPS, DEFAULTS, SPECS, type Settings } from "./settings"
import { RELEASES, VERSION } from "./version"

/** Toast policy: the panel and the form are the real feedback. */
function notify(
  context: ReturnType<typeof usePlugin>,
  level: "info" | "error",
  opts: { title?: string; message: string },
) {
  const policy = String(cfg().notifications)
  if (policy === "none") return
  if (policy === "errors only" && level === "info") return
  context.ui.toast.show({
    ...opts,
    variant: level === "error" ? "error" : "success",
    duration: Number(cfg()[level === "error" ? "toastErrorMs" : "toastInfoMs"]),
  })
}

// RPC errors are typed objects ({type, message, data}), not Error instances
function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === "object") {
    const e = err as { type?: string; message?: string; data?: { message?: string } }
    return [e.type, e.message, e.data?.message].filter(Boolean).join(" · ") || JSON.stringify(err)
  }
  return String(err)
}

/** Speech-safe error fingerprint for voice.log; never includes message text. */
function errLog(err: unknown): string {
  if (!err || typeof err !== "object") return typeof err
  const e = err as Record<string, unknown>
  const fields = ["name", "type", "code", "status"]
    .filter((key) => typeof e[key] === "string" || typeof e[key] === "number")
    .map((key) => `${key}=${String(e[key])}`)
  if (typeof e.message === "string") fields.push(`messageChars=${e.message.length}`)
  return fields.join(" ") || "unclassified object error"
}

// Ship a TUI-half event into the server's voice.log (best-effort). Toasts
// vanish in seconds; the intermittent delivery/RPC failures can only be
// debugged if they leave a trail on disk. NEVER speech content — lengths,
// ids, error shapes only.
let slogRpc: ((line: string, dbg: boolean) => void) | null = null
function slog(line: string, dbg = false): void {
  slogRpc?.(line, dbg)
}
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"

/** TUI half: live panel, keymap, settings/model menus, and draft delivery. */

// "disconnected": the status poll has failed repeatedly, so the panel would
// otherwise freeze on a stale but plausible state. Shown honestly instead.
type VoiceState = "setup" | "idle" | "recording" | "transcribing" | "error" | "disconnected"

// Fail closed during first-run hydration: until status proves the configured
// model exists, F9 opens model setup rather than attempting a doomed capture.
const [state, setState] = createSignal<VoiceState>("setup")
const [seconds, setSeconds] = createSignal(0)

const [cfg, setCfg] = createSignal<Settings>({ ...DEFAULTS })
const [cfgVersion, setCfgVersion] = createSignal(0)
const sNum = (k: string) => Number(cfg()[k])
const sStr = (k: string) => String(cfg()[k])
const model = () => sStr("model")
const recordKey = () => sStr("recordKey")
const settingsKey = () => sStr("settingsKey")
const restoreKey = () => sStr("restoreKey").trim()
type UpdateInfo = {
  installed: string
  latest: string
  available: boolean
  releases: Array<{ version: string; notes: string[] }>
}
const [availableUpdate, setAvailableUpdate] = createSignal<UpdateInfo | null>(null)
// true while the error state is a failed TRANSCRIPTION whose audio the
// safety net kept (capture failures have nothing to retry)
const [retryable, setRetryable] = createSignal(false)
// last finished transcription + the audio length of the take in flight
const [last, setLast] = createSignal<{ audioSec: number; loadMs: number; asrMs: number } | null>(null)
const [pendingAudioSec, setPendingAudioSec] = createSignal(0)
const [progress, setProgress] = createSignal({ processedSec: 0, totalSec: 0 })
// animation phase for the decorative meter (meterStyle "animated")
const [wavePhase, setWavePhase] = createSignal(0)
// real levels: newest on the right, scrolling left as samples arrive
const [levels, setLevels] = createSignal<number[]>([])

/** seconds -> m:ss, the one time format used everywhere */
function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

const BARS = "▁▂▃▄▅▆▇"
// measured by VoicePanel's box ref; 0 until the first onSizeChange
const [panelW, setPanelW] = createSignal(0)
// live setting, clamped BOTH ways: >=4 so a typo can't collapse the strip,
// and <= what the panel row actually holds (clock prefix + borders ≈ 9
// cells) — an oversized strip wraps in OpenTUI and fakes a left-to-right
// meter. Unmeasured panel (0) = no upper clamp yet.
const meterWidth = () => {
  const want = Math.max(4, Math.floor(sNum("meterWidth")) || 16)
  const w = panelW()
  return w > 13 ? Math.min(want, w - 9) : want
}
/**
 * Deliberately regular ripple travelling left-to-right. This is an
 * ANIMATION, not a pretend waveform — when real levels arrive it is
 * replaced, not mimicked.
 */
function levelMeter(history: number[]): string {
  const width = meterWidth()
  const cells = history.slice(-width)
  const pad = width - cells.length
  let out = " ".repeat(Math.max(0, pad))
  for (const v of cells) {
    const level = Math.round(Math.max(0, Math.min(1, v)) * (BARS.length - 1))
    out += BARS[level]
  }
  return out
}

function meter(phase: number): string {
  let out = ""
  for (let i = 0; i < meterWidth(); i++) {
    const v = Math.sin(phase - i * 0.55)
    const level = Math.round(((v + 1) / 2) * (BARS.length - 1))
    out += BARS[level]
  }
  return out
}






// real figures from the server's status RPC (2s poll; see VoicePanel)
const [stats, setStats] = createSignal({ rssMb: 0, cpuPct: 0, engineLoaded: false, recording: false })
const ram = () => `${stats().rssMb}M`
const cpu = () => `${stats().cpuPct}%`

// a model currently downloading (server events; shown inline in idle)
const [download, setDownload] = createSignal<{ name: string; pct: number } | null>(null)
let pendingSelect: string | null = null
let deferredSelect: string | null = null
let pendingTake: { sid: string; audioSec: number } | null = null
let recordingSessionID: string | null = null
// this TUI instance's identity: result/progress events are broadcast to
// every terminal; only the one that started the take may act on them
const CLIENT_ID = `tui-${Math.random().toString(36).slice(2, 10)}`

// ---- settings menu ---------------------------------------------------------

type Ctx = ReturnType<typeof usePlugin>

// JSON Schema gives RPC runtime validation but deliberately infers `unknown`
// in TypeScript. Keep the trusted, validated response shapes in one place.
type JsonResult = { json: string }
type VoiceMethods = {
  settingsSet(input: { json: string }): Promise<JsonResult>
  settingsGet(input: Record<string, never>): Promise<JsonResult>
  settingsReset(input: Record<string, never>): Promise<JsonResult>
  modelsList(input: Record<string, never>): Promise<JsonResult>
  logGet(input: { file?: "current" | "previous" }): Promise<JsonResult>
  devices(input: Record<string, never>): Promise<{
    devices: string[]
    recorders: Array<{ name: string; state: string }>
  }>
  level(input: Record<string, never>): Promise<{ level: number; recording: boolean }>
  status(input: Record<string, never>): Promise<{
    recording: boolean
    engineLoaded: boolean
    modelInstalled: boolean
    rssMb: number
    cpuPct: number
  }>
  recordStop(input: Record<string, never>): Promise<{ wav: string; seconds: number }>
  engineUnload(input: Record<string, never>): Promise<{ unloaded: boolean }>
  recoverPeek(input: Record<string, never>): Promise<{ kind: "draft" | "audio" | "both" | "none"; text: string; wav: string }>
  updateStatus(input: Record<string, never>): Promise<JsonResult>
  updateRefresh(input: { force?: boolean }): Promise<JsonResult>
  updateClaim(input: { version: string }): Promise<{ announce: boolean }>
  updateSettle(input: { version: string; acknowledged: boolean }): Promise<Record<string, never>>
}

function voiceRpc(context: Ctx) {
  const raw = context.client.rpc(Voice)
  return raw as Omit<typeof raw, keyof VoiceMethods> & VoiceMethods
}

function updateMessage(info: UpdateInfo): string {
  const notes = info.releases.length
    ? info.releases.map((release) => `v${release.version}\n${release.notes.map((line) => `• ${line}`).join("\n")}`).join("\n\n")
    : "A newer release is available. See the project release notes for details."
  return `OpenCode Voice v${info.latest} is available.\n\n${notes}\n\nNothing was installed or changed.`
}

function rememberUpdate(info: UpdateInfo, allowDisabled = false): void {
  setAvailableUpdate(info.available && (allowDisabled || String(cfg().updateCheck) !== "false") ? info : null)
}

async function releaseNotesMenu(context: Ctx): Promise<void> {
  const all = new Map(Object.entries(RELEASES))
  for (const release of availableUpdate()?.releases ?? []) all.set(release.version, release.notes)
  const entries = [...all.entries()].sort(([a], [b]) => {
    const av = a.split(".").map(Number)
    const bv = b.split(".").map(Number)
    return (bv[0] - av[0]) || (bv[1] - av[1]) || (bv[2] - av[2])
  })
  const choice = await context.ui.dialog.select({
    title: "OpenCode Voice release notes",
    options: entries.map(([version, notes]) => ({
      title: `v${version}`,
      value: version,
      description: notes.join(" · "),
    })),
  })
  if (!choice) return
  const notes = all.get(choice) ?? []
  await context.ui.dialog.alert({
    title: `OpenCode Voice v${choice}`,
    message: notes.map((line) => `• ${line}`).join("\n") || "No release notes recorded.",
  })
}

async function showAvailableUpdate(context: Ctx, info: UpdateInfo, claim: boolean, allowDisabled = false): Promise<void> {
  rememberUpdate(info, allowDisabled)
  if (!info.available || (!allowDisabled && String(cfg().updateCheck) === "false")) return
  if (claim) {
    const result = await voiceRpc(context).updateClaim({ version: info.latest }).catch(() => ({ announce: false }))
    if (!result.announce) return
  }
  const acknowledged = await context.ui.dialog.confirm({
    title: "Voice update available",
    message: `${updateMessage(info)}\n\nUpdate with OpenCode's plugin updater when you choose.`,
    label: { confirm: "Got it", cancel: "Remind me later" },
  })
  await voiceRpc(context).updateSettle({ version: info.latest, acknowledged: Boolean(acknowledged) }).catch(() => {})
}

const LANGUAGES: Array<[string, string]> = [
  ["auto", "Auto-detect"], ["en", "English"], ["ka", "Georgian"], ["ru", "Russian"],
  ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["it", "Italian"],
  ["pt", "Portuguese"], ["nl", "Dutch"], ["pl", "Polish"], ["tr", "Turkish"],
  ["uk", "Ukrainian"], ["hy", "Armenian"], ["az", "Azerbaijani"], ["zh", "Chinese"],
  ["ja", "Japanese"], ["ko", "Korean"], ["ar", "Arabic"], ["hi", "Hindi"],
]

/** Push a patch to the server (source of truth) and refresh the local copy. */
async function save(context: Ctx, patch: Settings) {
  const r = await voiceRpc(context).settingsSet({ json: JSON.stringify(patch) })
  setCfg(JSON.parse(r.json) as Settings)
  if (patch.updateCheck === false || patch.updateCheck === "false") setAvailableUpdate(null)
  if (patch.updateCheck === true || patch.updateCheck === "true") {
    const info = JSON.parse((await voiceRpc(context).updateRefresh({ force: true })).json) as UpdateInfo
    await showAvailableUpdate(context, info, true)
  }
  setCfgVersion((v) => v + 1)
}

async function applyDeferredModel(context: Ctx): Promise<void> {
  const name = deferredSelect
  if (!name || state() === "recording" || state() === "transcribing") return
  deferredSelect = null
  await save(context, { model: name })
  notify(context, "info", { message: `${name} ready and selected` })
}

async function editSetting(context: Ctx, key: string) {
  const spec = SPECS.find((x) => x.key === key)
  if (!spec) return
  const value = cfg()[key]
  const title = `${spec.label}${spec.hint ? ` — ${spec.hint}` : ""}`

  // discoverable values get pickers, never free-text prompts
  if (key === "threads") {
    const max = navigator.hardwareConcurrency ?? 8
    const recommended = Math.max(1, max - 2)
    const picked = await context.ui.dialog.select({
      title: "Engine threads",
      current: String(value),
      options: Array.from({ length: max }, (_, i) => {
        const n = i + 1
        const tag =
          n === recommended ? "  ← default (cores − 2)" : n === max ? "  (all cores — UI may stutter)" : ""
        return { title: `${n}${tag}`, value: String(n) }
      }),
    })
    if (picked) await save(context, { threads: Number(picked) })
    return
  }
  if (key === "model") {
    await modelManager(context)
    return
  }
  if (key === "language") {
    const enOnly = String(cfg().model).endsWith(".en")
    const picked = await context.ui.dialog.select({
      title: enOnly ? `Language — ${cfg().model} is English-only; applies when a multilingual model is active` : "Language",
      current: String(value),
      options: LANGUAGES.map(([code, name]) => ({ title: `${name} (${code})`, value: code })),
    })
    if (picked) await save(context, { language: picked })
    return
  }
  if (key === "recorder") {
    const { recorders } = await voiceRpc(context).devices({})
    const states = new Map(recorders.map((r) => [r.name, r.state]))
    const firstOk = recorders.find((r) => r.state === "ok")?.name
    const picked = await context.ui.dialog.select({
      title,
      current: String(value),
      options: (spec.choices ?? []).map((o) => {
        const state = o === "auto" ? "ok" : (states.get(o) ?? "ok")
        // every row states its status: installed / available (= could be
        // installed, isn't) / not available on this OS
        const suffix =
          o === "auto"
            ? `  (recommended${firstOk ? ` — uses ${firstOk}` : ""})`
            : state === "ok"
              ? "  — installed"
              : state === "not available"
                ? "  — not available on this OS"
                : "  — available"
        return { title: `${o}${suffix}`, value: o }
      }),
    })
    if (picked === undefined) return
    const state = picked === "auto" ? "ok" : (states.get(picked) ?? "ok")
    if (state !== "ok") {
      // ignore the pick, keep the previous value (user decision over
      // unselectable rows — the host drops disabled options entirely)
      context.ui.toast.show({
        title: "recorder unchanged",
        message:
          state === "not available"
            ? `${picked} is not available on this OS`
            : `${picked} is not installed — install it to use it`,
        variant: "error",
      })
      return
    }
    await save(context, { recorder: picked })
    return
  }
  if (key === "device") {
    const { devices } = await voiceRpc(context).devices({})
    const picked = await context.ui.dialog.select({
      title: "Input device",
      current: String(value),
      options: devices.map((dev) => ({ title: dev, value: dev })),
    })
    if (picked) await save(context, { device: picked })
    return
  }

  if (spec.kind === "choice" || spec.kind === "boolean") {
    const options =
      spec.kind === "boolean"
        ? ["true", "false"]
        : (spec.choices ?? [])
    const picked = await context.ui.dialog.select({
      title,
      current: String(value),
      options: options.map((o) => ({
        title: o === String(spec.recommended) ? `${o}  (recommended)` : o,
        value: o,
      })),
    })
    if (picked === undefined) return
    await save(context, { [key]: spec.kind === "boolean" ? picked === "true" : picked })
    return
  }

  const typed = await context.ui.dialog.prompt({
    title,
    placeholder: `recommended: ${spec.recommended}`,
    value: String(value),
  })
  if (typed === undefined) return
  if (typed.trim() === "") {
    // cleared field + enter = revert to the recommended default
    // (previous value if a spec ever ships without one)
    await save(context, { [key]: spec.recommended ?? value })
    return
  }
  const next = spec.kind === "number" ? Number(typed) : typed.trim()
  if (spec.kind === "number" && Number.isNaN(next)) {
    context.ui.toast.show({ title: "not a number", message: typed, variant: "error" })
    return
  }
  await save(context, { [key]: next })
}

let menuCursor: string | undefined

type CatalogRow = { name: string; downloadMb: number; note: string; status: "installed" | "downloading" | "queued" | "available" }

/** enter = use (auto-select after download) · ctrl+d = download only · ctrl+x = delete */
async function modelManager(context: Ctx) {
  // cursor memory across the reopen after ctrl+d / ctrl+x (dialog.clear)
  let cursor: string | null = null
  let confirmDelete: string | null = null
  let neighbourNameAfterDelete: string | null = null
  while (true) {
    if (confirmDelete) {
      const name = confirmDelete
      confirmDelete = null
      const ok = await context.ui.dialog.confirm({
        title: `Delete ${name}`,
        message: "Remove the downloaded model files? You can re-download it any time.",
        label: { confirm: "Delete", cancel: "Keep" },
      })
      if (ok) {
        cursor = neighbourNameAfterDelete ?? cursor
        await voiceRpc(context).modelDelete({ name }).catch(() => {})
        context.ui.toast.show({ message: `${name} deleted`, duration: 3000 })
      } else cursor = name
    }
    const r = await voiceRpc(context).modelsList({})
    const rows = JSON.parse(r.json) as CatalogRow[]
    let refresh = false
    const sorted = [...rows].sort((a, b) => {
      const rank = { installed: 0, downloading: 1, queued: 2, available: 3 }
      return rank[a.status] - rank[b.status]
    })
    // the acted-on row migrates to another section; keep the cursor HERE by
    // targeting its neighbour instead of following the row to its new home
    const neighbourOf = (name: string): string => {
      const i = sorted.findIndex((m) => m.name === name)
      return sorted[i + 1]?.name ?? sorted[i - 1]?.name ?? name
    }
    const startDownload = (name: string) =>
      voiceRpc(context)
        .modelDownload({ name })
        .catch((err) => notify(context, "error", { title: "download failed to start", message: errText(err) }))
    const picked = await context.ui.dialog.select({
      title: "Models — enter: use · ctrl+d: download · ctrl+x: delete/cancel",
      current: cursor ?? String(cfg().model),
      options: sorted.map((m) => {
        // the CATEGORY is the status — no icons, no colors, just words
        const category = { installed: "Downloaded", downloading: "Downloading", queued: "Queued", available: "Available" }[m.status]
        const pct = m.status === "downloading" && download()?.name === m.name ? ` ${download()?.pct}%` : ""
        return {
          title: `${(m.name + pct).padEnd(20)} ${m.downloadMb ? `${String(m.downloadMb).padStart(4)}M` : "    –"}`,
          value: m.name,
          description: m.note || undefined,
          category,
        }
      }),
      actions: [
        {
          bind: "ctrl+d",
          title: "Download",
          onTrigger: (name: string) => {
            const row = rows.find((m) => m.name === name)
            if (!row || row.status !== "available") return
            refresh = true
            cursor = neighbourOf(name)
            void startDownload(name)
            context.ui.dialog.clear() // reopen with the queued state visible
          },
        },
        {
          bind: "ctrl+x",
          title: "Delete / cancel",
          onTrigger: (name: string) => {
            const row = rows.find((m) => m.name === name)
            if (!row) return
            if (row.status === "downloading" || row.status === "queued") {
              refresh = true
              cursor = neighbourOf(name)
              if (pendingSelect === name) pendingSelect = null
              void voiceRpc(context).modelCancel({ name }).then(() => {
                setDownload(null)
                context.ui.toast.show({ message: `${name} download cancelled`, duration: 3000 })
                context.ui.dialog.clear()
              })
              return
            }
            if (row.status !== "installed") return
            if (name === String(cfg().model)) {
              context.ui.toast.show({ title: "model in use", message: "switch models before deleting this one", variant: "error" })
              return
            }
            refresh = true
            confirmDelete = name
            neighbourNameAfterDelete = neighbourOf(name)
            context.ui.dialog.clear() // loop runs the confirmation next
          },
        },
      ],
    })
    if (picked === undefined) {
      if (refresh) continue // reopened after ctrl+d/ctrl+x with a fresh list
      return
    }
    const row = rows.find((m) => m.name === picked)
    if (!row) return
    if (row.status === "installed") {
      await save(context, { model: picked })
      return
    }
    if (row.status === "downloading" || row.status === "queued") {
      pendingSelect = picked // enter on an in-flight model: select when done
      context.ui.toast.show({ message: `${picked} will be selected when ready`, duration: 4000 })
      return
    }
    const ok = await context.ui.dialog.confirm({
      title: `Download ${picked}`,
      message: `${row.downloadMb}M download${row.note ? ` — ${row.note}` : ""}. Download and switch to it when ready?`,
      label: { confirm: "Download + select", cancel: "Not now" },
    })
    if (!ok) continue
    pendingSelect = picked
    await startDownload(picked)
    context.ui.toast.show({ message: `downloading ${picked} — progress in the Voice panel`, duration: 5000 })
    return
  }
}

async function hydrate(context: Ctx) {
  await voiceRpc(context)
    .settingsGet({})
    .then((r) => setCfg(JSON.parse(r.json) as Settings))
    .catch(() => {})
}

async function settingsMenu(context: Ctx, startAt?: string) {
  // cursor memory lives only within one open menu; a fresh open starts clean
  menuCursor = startAt
  try {
    await settingsMenuLoop(context)
  } finally {
    // refresh on CLOSE: whatever changed inside is live the moment we leave
    await hydrate(context)
    setCfgVersion((v) => v + 1)
  }
}

function specRow(key: string) {
  const spec = SPECS.find((x) => x.key === key)!
  const value = String(cfg()[spec.key])
  const drifted = cfg()[spec.key] !== spec.recommended
  return {
    title: `${spec.label.padEnd(18)} ${value}${drifted ? "  *" : ""}`,
    value: spec.key,
    category: spec.group,
    description: [spec.hint, drifted ? `recommended: ${spec.recommended}` : null].filter(Boolean).join("  ·  ") || undefined,
  }
}

// second page: everything tuned-by-default, in themed sections
let advCursor: string | undefined
async function advancedMenu(context: Ctx) {
  advCursor = undefined
  while (true) {
    const rows = SPECS.filter((spec) => ADVANCED_GROUPS.includes(spec.group)).map((spec) => specRow(spec.key))
    const choice: string | undefined = await context.ui.dialog.select({
      title: "Advanced — defaults are tuned   (* = changed)",
      current: advCursor,
      options: rows,
    })
    if (!choice) return // esc: back to the main menu loop
    advCursor = choice
    await editSetting(context, choice)
    await hydrate(context)
  }
}

async function settingsMenuLoop(context: Ctx) {
  await hydrate(context)
  while (true) {
    const choice = await context.ui.dialog.select({
      title: "Voice settings   (* = changed from recommended)",
      current: menuCursor,
      options: [
        ...SPECS.filter((spec) => !ADVANCED_GROUPS.includes(spec.group)).map((spec) => specRow(spec.key)),
        {
          title: "Advanced…",
          value: "@advanced",
          category: "More",
          // undocumented but real: the native fuzzy filter also matches an
          // option's searchText (binary: fuzzysort keys title/category/
          // searchText; the bridge spreads options through untouched). So
          // typing any advanced setting's name keeps this row in the
          // results — enter lands on the advanced page. Closest thing to
          // cross-page search the host allows (a custom search callback
          // would render the whole list flat).
          searchText: SPECS.filter((spec) => ADVANCED_GROUPS.includes(spec.group))
            .map((spec) => `${spec.label} ${spec.key} ${spec.group}`)
            .join(" "),
        } as { title: string; value: string; category: string },
        { title: "Show log", value: "@log", category: "More" },
        { title: "Check for updates now", value: "@check", category: "More" },
        ...(availableUpdate()
          ? [{ title: `Update available: v${availableUpdate()!.latest}`, value: "@update", category: "More" }]
          : []),
        { title: "Browse release notes…", value: "@whatsnew", category: "More" },
        {
          title: stats().engineLoaded ? "Unload model from memory now" : "Unload model from memory (not loaded)",
          value: "@unload",
          category: "More",
        },
        { title: "Reset everything to recommended", value: "@reset", category: "More" },
      ],
    })
    if (!choice) return
    menuCursor = choice
    if (choice === "@unload") {
      try {
        const r = await voiceRpc(context).engineUnload({})
        setStats({ ...stats(), engineLoaded: false })
        notify(context, "info", { message: r.unloaded ? "model unloaded; next take reloads it" : "model was not loaded" })
        return // one-shot action: return to the panel's now-cold state
      } catch (err) {
        notify(context, "error", { title: "could not unload", message: errText(err) })
      }
      continue
    }
    if (choice === "@advanced") {
      await advancedMenu(context)
      continue
    }
    if (choice === "@log") {
      context.ui.router.navigate({ type: "plugin", name: "voice-log" })
      return
    }
    if (choice === "@update") {
      const info = availableUpdate()
      if (info) await showAvailableUpdate(context, info, false)
      continue
    }
    if (choice === "@check") {
      const info = JSON.parse((await voiceRpc(context).updateRefresh({ force: true })).json) as UpdateInfo
      rememberUpdate(info, true)
      if (info.available) await showAvailableUpdate(context, info, true, true)
      else context.ui.toast.show({ title: "OpenCode Voice", message: `up to date — v${VERSION}`, duration: 5000 })
      continue
    }
    if (choice === "@whatsnew") {
      await releaseNotesMenu(context)
      continue
    }
    if (choice === "@reset") {
      const ok = await context.ui.dialog.confirm({
        title: "Reset settings",
        message: "Restore every setting to its recommended value?",
        label: { confirm: "Reset", cancel: "Keep" },
      })
      if (ok) {
        const r = await voiceRpc(context).settingsReset({})
        setCfg(JSON.parse(r.json) as Settings)
        const info = JSON.parse((await voiceRpc(context).updateRefresh({})).json) as UpdateInfo
        await showAvailableUpdate(context, info, true)
      }
      continue
    }
    await editSetting(context, choice)
    await hydrate(context)
  }
}

// ---- log page (spacious view via router) -----------------------------------

const [lastSessionID, setLastSessionID] = createSignal<string | null>(null)

const [logLines, setLogLines] = createSignal<string[]>([])
const [logFile, setLogFile] = createSignal<string | null>(null)
const [logSource, setLogSource] = createSignal<"current" | "previous">("current")

function LogPage() {
  const context = usePlugin()
  const loadLog = (file = logSource()) => {
    setLogSource(file)
    void voiceRpc(context)
      .logGet({ file })
      .then((r) => {
        const d = JSON.parse(r.json) as { path: string | null; lines: string[] }
        setLogFile(d.path)
        setLogLines(d.lines)
      })
      .catch(() => setLogLines(["(log unavailable)"]))
  }
  loadLog()
  const goBack = () => {
    const sid = lastSessionID()
    context.ui.router.navigate(sid ? { type: "session", sessionID: sid } : { type: "home" })
    // the log is reached through the menu, so back = the menu, same row
    void settingsMenu(context, "@log")
  }
  // disposed with the page, so esc is captured only while the log is open
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      { id: "voice.log.back", title: "Voice log: back", bind: "escape", run: () => goBack() },
      {
        id: "voice.log.switch", title: "Voice log: switch current/previous", bind: "tab",
        run: () => loadLog(logSource() === "current" ? "previous" : "current"),
      },
    ],
  }))
  return (
    <box border borderStyle="rounded" borderColor={context.theme.text.muted} title={`Voice · ${logSource()} log`} flexDirection="column" flexGrow={1}>
      <text fg={context.theme.text.base}>{logFile() ? `file: ${logFile()}` : "in-memory only (file unavailable)"}</text>
      <scrollbox flexGrow={1} scrollY stickyScroll stickyStart="bottom">
        <For each={logLines()}>{(line) => <text fg={context.theme.text.muted}>{line}</text>}</For>
      </scrollbox>
      <text fg={context.theme.text.base}>— ↑/↓ scroll · tab switch · esc back —</text>
    </box>
  )
}

// ---- sidebar panel ----------------------------------------------------------

function bar(pct: number, width = 14) {
  const full = Math.round((pct / 100) * width)
  return "▓".repeat(full) + "░".repeat(width - full)
}

function VoicePanel() {
  const context = usePlugin()
  const base = context.theme.text.base
  const muted = context.theme.text.muted

  const tick = setInterval(() => {
    if (state() === "recording" || state() === "transcribing") setSeconds((s) => s + 1)
  }, 1000)
  // these two intervals follow their settings live: reading sNum() inside
  // createEffect tracks cfg, so a change tears the old timer down and starts
  // a new one at the new rate (clamped against typo'd values)
  createEffect(() => {
    const ms = Math.max(50, sNum("meterIntervalMs") || 150)
    const wave = setInterval(() => {
      if (state() !== "recording") return
      const style = sStr("meterStyle")
      if (style === "off") return
      if (style === "animated") {
        setWavePhase((p) => p + 0.55)
        return
      }
      voiceRpc(context)
        .level({})
        .then((r) => {
          if (!r.recording) return
          setLevels((prev) => [...prev, r.level].slice(-meterWidth()))
        })
        .catch(() => {})
    }, ms)
    onCleanup(() => clearInterval(wave))
  })
  createEffect(() => {
    const ms = Math.max(250, sNum("statsIntervalMs") || 2000)
    // The server is the source of truth. Reconcile on every poll so the panel
    // is eventually consistent even if an event was missed or another window
    // acted; after repeated failures say "disconnected" rather than freeze on
    // a stale but plausible state.
    let misses = 0
    const refresh = () => {
      voiceRpc(context)
        .status({})
        .then((st) => {
          misses = 0
          setStats(st)
          const m = st.modelInstalled
          if (state() === "disconnected") setState(m ? "idle" : "setup")
          if (m === false && (state() === "idle" || state() === "error")) setState("setup")
          else if (m === true && state() === "setup") setState("idle")
          if (state() === "recording" && !st.recording) {
            setState("idle")
            recordingSessionID = null
          }
        })
        .catch(() => {
          if (++misses >= 3 && state() !== "disconnected") setState("disconnected")
        })
    }
    refresh()
    const poll = setInterval(refresh, ms)
    onCleanup(() => clearInterval(poll))
  })
  onCleanup(() => clearInterval(tick))
  const clock = () => `${Math.floor(seconds() / 60)}:${String(seconds() % 60).padStart(2, "0")}`

  // full-width divider between info block and action block
  // auto-width: measure the row's own renderable, re-measure on resize
  const Divider = () => {
    const [w, setW] = createSignal(0)
    return (
      <box
        height={1}
        ref={(r: { width: number; onSizeChange?: () => void }) => {
          const measure = () => setW(r.width)
          r.onSizeChange = measure
          measure()
        }}
      >
        <text fg={muted}>{"_".repeat(Math.max(0, w()))}</text>
      </box>
    )
  }

  // key glyph gets the accent colour, its description stays muted
  const accent = context.theme.text.accent ?? base
  const Action = (p: { kbd: string; label: string }) => (
    <box flexDirection="row">
      <text fg={accent}>{p.kbd}</text>
      <text fg={muted}>{`  ${p.label}`}</text>
    </box>
  )
  // two actions: first sticks to the left wall, second to the right
  const Actions = (p: { aKey: string; aLabel: string; bKey: string; bLabel: string }) => (
    <box flexDirection="row">
      <text fg={accent}>{p.aKey}</text>
      <text fg={muted}>{`  ${p.aLabel}`}</text>
      <box flexGrow={1} />
      <text fg={accent}>{p.bKey}</text>
      <text fg={muted}>{`  ${p.bLabel}`}</text>
    </box>
  )

  // measured title: dashes computed so "Menu:<key>" ends one cell from the
  // right corner, mirroring Voice's offset from the left. TUNE absorbs the
  // border/padding cells the title row doesn't cover.
  const TUNE = 4
  const title = () => {
    const key = settingsKey()
    const voice = `Voice v${VERSION}${availableUpdate() ? "↑" : ""}`
    const fixed = voice.length + `Menu:${key}`.length
    const w = panelW()
    if (w <= fixed + TUNE + 2) return `${voice}──Menu:${key}` // unmeasured/narrow: static fallback
    return `${voice}${"─".repeat(w - fixed - TUNE)}Menu:${key}`
  }

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={muted}
      ref={(r: { width: number; onSizeChange?: () => void }) => {
        const measure = () => setPanelW(r.width)
        r.onSizeChange = measure
        measure()
      }}
      title={title()}
      bottomTitle={`C:${cpu().padStart(4)} R:${ram().padStart(5)}`}
      bottomTitleAlignment="right"
    >
      <Show when={(state() === "idle" || state() === "setup") && download()}>
        {(dl) => (
          <>
            <text fg={base}>{`⇣ ${dl().name}`}</text>
            <text fg={muted}>{`${bar(dl().pct)} ${dl().pct}%`}</text>
            <Divider />
            <Action kbd={recordKey()} label={state() === "setup" ? "models" : "record"} />
          </>
        )}
      </Show>
      <Show when={state() === "idle" && !download()}>
        <text fg={base}>{`${stats().engineLoaded ? "●" : "○"} ready · ${model()}`}</text>
        <Show when={last()} fallback={<text fg={muted}>no takes yet</text>}>
          {(l) => (
            <text fg={muted}>{`load ${(l().loadMs / 1000).toFixed(1)}s · ${fmt(l().audioSec)} in ${fmt(l().asrMs / 1000)}`}</text>
          )}
        </Show>
        <Divider />
        <Action kbd={recordKey()} label="record" />
      </Show>
      <Show when={state() === "recording"}>
        <text fg={base}>{`⏺ recording · ${model()}`}</text>
        <text fg={muted}>
          {sStr("meterStyle") === "off"
            ? clock()
            : `${clock()} ${sStr("meterStyle") === "animated" ? meter(wavePhase()) : levelMeter(levels())}`}
        </text>
        <Divider />
        <Actions aKey={recordKey()} aLabel="stop" bKey="esc" bLabel="cancel" />
      </Show>
      <Show when={state() === "transcribing"}>
        <text fg={base}>{`◌ working · ${model()}`}</text>
        <text fg={muted}>{`${fmt(progress().processedSec)} of ${fmt(progress().totalSec || pendingAudioSec())} audio`}</text>
        <Divider />
        <Action kbd={settingsKey()} label="menu" />
      </Show>
      <Show when={state() === "setup" && !download()}>
        <text fg={base}>⚠ no model installed</text>
        <text fg={muted}>download one to start</text>
        <Divider />
        <Action kbd={recordKey()} label="get a model" />
      </Show>
      <Show when={state() === "error"}>
        <text fg={base}>{`✗ failed · ${model()}`}</text>
        <text fg={muted}>{retryable() ? "take kept — retry it" : "mic unavailable"}</text>
        <Divider />
        <Show when={retryable() && restoreKey()}>
          <Action kbd={restoreKey()} label="retry take" />
        </Show>
        <Action kbd={recordKey()} label="record again" />
        <Action kbd={settingsKey()} label="menu" />
      </Show>
      <Show when={state() === "disconnected"}>
        <text fg={base}>✗ voice server unreachable</text>
        <text fg={muted}>reload the plugin or restart opencode</text>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "@juliuskb/opencode-voice/tui",
  setup(context) {
    const onCleanupTui: Array<() => void> = []
    const disposeRoute = context.ui.router.register({
      name: "voice-log",
      render: () => <LogPage />,
    })

    context.keymap.layer(() => {
      void cfgVersion() // tracked: re-evaluate bindings right after a settings change
      return {
      mode: "global",
      commands: [
        {
          id: "voice.record.toggle",
          title: "Voice: record / stop",
          group: "Voice",
          bind: recordKey(),
          palette: true,
          slash: { name: "voice" },
          run: async () => {
            const rpc = voiceRpc(context)
            if (state() === "setup") {
              void modelManager(context)
              return
            }
            if (state() === "disconnected") {
              notify(context, "error", { title: "voice server unreachable", message: "reload the plugin or restart opencode" })
              return
            }
            if (state() === "transcribing") {
              notify(context, "info", { message: "finish the current transcription first" })
              return
            }
            if (state() === "recording") {
              try {
                const r = await rpc.recordStop({})
                setSeconds(0)
                setPendingAudioSec(r.seconds)
                setProgress({ processedSec: 0, totalSec: r.seconds })
                pendingTake = { sid: recordingSessionID ?? "", audioSec: r.seconds }
                recordingSessionID = null
                setState("transcribing")
                await rpc.transcribe({ wav: r.wav, client: CLIENT_ID }) // returns immediately; result is an event
              } catch (err) {
                setState("error")
                setRetryable(false)
                void applyDeferredModel(context)
                slog(`capture failed (stop/transcribe): ${errLog(err)}`)
                notify(context, "error", { title: "capture failed", message: errText(err) })
              }
              return
            }
            try {
              const route = context.ui.router.current()
              if (route.type !== "session") {
                notify(context, "error", { title: "open a chat first", message: "voice drafts need a destination chat" })
                return
              }
              await rpc.recordStart({})
              recordingSessionID = route.sessionID
              setSeconds(0)
              setLevels([])
              setState("recording")
            } catch (err) {
              setState("error")
              setRetryable(false)
              slog(`record start failed: ${errLog(err)}`)
              notify(context, "error", { title: "could not record", message: errText(err) })
            }
          },
        },
        {
          id: "voice.restore.draft",
          title: "Restore last transcript",
          group: "Voice drafts",
          ...(String(cfg().restoreKey).trim() ? { bind: String(cfg().restoreKey).trim() } : {}),
          palette: true,
          run: async () => {
            context.ui.dialog.clear()
            let ok = await delivery.restoreLast().catch(() => false)
            // safety net: the in-memory draft may have died with the process
            // (its disk shadow survives), and a take whose delivery failed
            // still has audio on disk. Always peek — a successful in-memory
            // re-raise must not hide audio that is waiting to be re-transcribed.
            const r = await voiceRpc(context).recoverPeek({}).catch(() => null)
            if (r) slog(`restore: disk has ${r.kind}`, true)
            if (!ok && (r?.kind === "draft" || r?.kind === "both")) {
              const route = context.ui.router.current()
              const sid = route.type === "session" ? route.sessionID : null
              if (sid)
                ok = await delivery
                  .push(sid, r.text)
                  .then(() => true)
                  .catch(() => false)
              else notify(context, "error", { title: "open a chat first", message: "recovery needs a destination chat" })
            }
            // audio is recovered whenever it exists; when a draft was also
            // restored, the take is appended to that form once transcribed
            if (r?.kind === "audio" || (r?.kind === "both" && ok)) {
              const route = context.ui.router.current()
              if (route.type !== "session") {
                notify(context, "error", { title: "open a chat first", message: "recovery needs a destination chat" })
                return
              }
              pendingTake = { sid: route.sessionID, audioSec: 0 }
              setState("transcribing")
              notify(context, "info", { message: ok ? "draft restored; re-transcribing saved take" : "re-transcribing last take" })
              await voiceRpc(context)
                .transcribe({ wav: r.wav, client: CLIENT_ID })
                .catch((err) => {
                  setState("error")
                  setRetryable(true)
                  slog(`retry transcribe failed to start: ${errLog(err)}`)
                  notify(context, "error", { title: "retry failed", message: errText(err) })
                })
              return
            }
            if (ok) notify(context, "info", { message: "draft restored" })
            else context.ui.toast.show({ message: "nothing to restore", duration: 4000 })
          },
        },
        {
          id: "voice.settings",
          title: "Voice: settings",
          group: "Voice",
          bind: settingsKey(),
          palette: true,
          run: () => void settingsMenu(context),
        },
      ],
    }})

    let settingsHydrated = false
    let pendingUpdate: UpdateInfo | null = null
    const acceptUpdate = (info: UpdateInfo) => {
      if (!settingsHydrated) {
        pendingUpdate = info
        return
      }
      // A late network result must not replace a dialog the user already
      // opened. It updates the panel/menu now; the one-time modal is claimed
      // from cached state during startup (or opened manually from the menu).
      rememberUpdate(info)
    }
    const offUpdate = voiceRpc(context).events.on("update", (event) => {
      const data = event.data as { json: string }
      try {
        acceptUpdate(JSON.parse(data.json) as UpdateInfo)
      } catch {
        // malformed optional metadata is ignored
      }
    })
    onCleanupTui.push(offUpdate)

    voiceRpc(context)
      .settingsGet({})
      .then(async (r) => {
        setCfg(JSON.parse(r.json) as Settings)
        settingsHydrated = true
        if (pendingUpdate) rememberUpdate(pendingUpdate)
        pendingUpdate = null
        const current = JSON.parse((await voiceRpc(context).updateRefresh({})).json) as UpdateInfo
        await showAvailableUpdate(context, current, true)
      })
      .catch(() => {})

    slogRpc = (line, dbg) => void voiceRpc(context).clientLog({ line, debug: dbg }).catch(() => {})
    const delivery = formDelivery(context.client as unknown as Client, {
      save: async (text, take) => {
        await voiceRpc(context).draftSave(take ? { text, take } : { text })
      },
      clear: async () => {
        await voiceRpc(context).draftClear({})
      },
      // step-level forensics from delivery: failures go to the main log,
      // ok-timelines ride the debug gate
      trace: (line) => slog(line, !/fail/i.test(line)),
    })

    // event-driven delivery: no polling courier
    const offReplied = context.data.on("form.replied", (event) => {
      const { id, sessionID, answer } = event.data as {
        id: string
        sessionID: string
        answer: Record<string, unknown>
      }
      if (!delivery.owns(id)) return
      const text = String(answer.text ?? "")
      slog(`form replied: ${id}, ${text.length} chars`, true)
      delivery
        .submitted(sessionID, id, text)
        .then(() => notify(context, "info", { message: "sent" }))
        .catch((err) => {
          // delivery.trace already logged the step detail; this adds the
          // user-visible outcome so the log tells the whole story
          slog(`send FAILED (draft kept on disk): ${errLog(err)}`)
          notify(context, "error", { title: "send failed", message: errText(err) })
        })
    })
    const offDownload = voiceRpc(context).events.on("download", (event) => {
      const d = event.data as { name: string; pct: number; error?: string }
      if (d.pct < 0) {
        setDownload(null)
        pendingSelect = null
        if ((d.error ?? "").includes("abort") || (d.error ?? "").includes("cancel"))
          notify(context, "info", { message: `${d.name} download cancelled` })
        else notify(context, "error", { title: `download failed: ${d.name}`, message: d.error ?? "unknown error" })
        return
      }
      setDownload(d.pct >= 100 ? null : d)
      if (d.pct >= 100 && pendingSelect === d.name) {
        pendingSelect = null
        if (state() === "recording" || state() === "transcribing") {
          deferredSelect = d.name
          notify(context, "info", { message: `${d.name} ready — switches after this take` })
        } else {
          deferredSelect = d.name
          void applyDeferredModel(context)
        }
      }
    })
    onCleanupTui.push(offDownload)

    const offResult = voiceRpc(context).events.on("result", (event) => {
      const d = event.data as { client: string; text?: string; loadMs?: number; transcribeMs?: number; take?: string; error?: string }
      if (d.client !== CLIENT_ID) return // another terminal's take
      const take = pendingTake
      pendingTake = null
      if (d.error !== undefined) {
        setState("error")
        void applyDeferredModel(context)
        const kept = String(cfg().safetyNet ?? "true") !== "false"
        setRetryable(kept)
        notify(context, "error", {
          title: "transcription failed",
          message: kept ? `${d.error} — audio kept; Restore last transcript retries it` : d.error,
        })
        return
      }
      setLast({ audioSec: take?.audioSec ?? 0, loadMs: d.loadMs ?? 0, asrMs: d.transcribeMs ?? 0 })
      setState("idle")
      void applyDeferredModel(context)
      const text = d.text ?? ""
      if (!text) {
        notify(context, "info", { message: "nothing heard" })
        return
      }
      const sid = take?.sid
      if (!sid) {
        slog(`delivery skipped: no chat to send to (${text.length} chars; transcript is on disk)`)
        notify(context, "error", { title: "no chat to send to", message: text })
        return
      }
      // a form steals input scope from any open dialog, stranding it
      // mouse-only — close our own dialogs before delivering
      context.ui.dialog.clear()
      void delivery
        .push(sid, text, d.take)
        .then(({ extended }) => extended && notify(context, "info", { message: "added to draft" }))
        .catch((err) => {
          slog(`delivery FAILED (transcript kept on disk): ${errLog(err)}`)
          notify(context, "error", { title: "delivery failed", message: errText(err) })
        })
    })
    onCleanupTui.push(offResult)

    const offProgress = voiceRpc(context).events.on("progress", (event) => {
      const d = event.data as { client: string; processedSec: number; totalSec: number }
      if (d.client !== CLIENT_ID) return
      setProgress((prev) =>
        d.processedSec >= prev.processedSec
          ? { processedSec: d.processedSec, totalSec: d.totalSec }
          : prev,
      )
    })
    onCleanupTui.push(offProgress)

    const offCancelled = context.data.on("form.cancelled", (event) => {
      const { id } = event.data as { id: string }
      if (!delivery.owns(id)) return
      delivery.forget(id)
      slog(`form cancelled: ${id}`, true)
      notify(context, "info", { message: "transcript discarded" })
    })
    onCleanupTui.push(offReplied, offCancelled)

    context.keymap.layer(() => ({
      mode: "global",
      enabled: () => state() === "recording",
      commands: [
        {
          id: "voice.record.cancel",
          title: "Voice: cancel recording",
          bind: "escape",
          run: async () => {
            await voiceRpc(context).recordCancel({})
            recordingSessionID = null
            setState("idle")
            void applyDeferredModel(context)
            notify(context, "info", { message: "recording discarded" })
          },
        },
      ],
    }))

    const disposeSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        // routes without a session (log page, home) must not erase the memory
        if (input.sessionID) setLastSessionID(input.sessionID)
        return <VoicePanel />
      },
    })

    return () => {
      for (const off of onCleanupTui) off()
      disposeRoute()
      disposeSlot()
    }
  },
})
