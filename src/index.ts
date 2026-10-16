import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { cpus, tmpdir } from "node:os"
import { Plugin } from "@opencode/plugin"
import { Voice } from "./rpc"
import * as capture from "./capture"

// ---- decode worker: keeps sherpa's blocking decode OFF the server loop ----
type WorkerMsg =
  | { type: "progress"; id: number; processedSec: number; totalSec: number }
  | { type: "done"; id: number; text: string; loadMs: number; transcribeMs: number; wasLoaded: boolean }
  | { type: "error"; id: number; message: string }
  | { type: "log"; line: string }
import * as settings from "./settings"
import * as catalog from "./catalog"
import { debug, dump, init as initLog, log } from "./log"

// Whole opencode-server usage, by user decision: honest (no fake
// engine-attribution) and doubles as a general health readout. CPU is
// normalized to whole-machine capacity.
const CORES = Math.max(1, cpus().length)
let lastCpu = process.cpuUsage()
let lastCpuAt = performance.now()
function processStats(): { rssMb: number; cpuPct: number } {
  const now = performance.now()
  const cpu = process.cpuUsage()
  const busyMs = (cpu.user + cpu.system - lastCpu.user - lastCpu.system) / 1000
  const wallMs = Math.max(1, now - lastCpuAt)
  lastCpu = cpu
  lastCpuAt = now
  return {
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    cpuPct: Math.min(100, Math.round((busyMs / wallMs / CORES) * 100)),
  }
}

/**
 * Server half: the engine worker, capture, model catalog, settings and log —
 * everything that must exist once per server rather than per terminal.
 */
export default Plugin.define({
  id: "voice",
  async setup(ctx) {
    // settings live in a JSON file in the data dir (see settings.ts for why
    // opencode's location-scoped plugin storage was abandoned)
    await settings.hydrate()
    initLog()

    let worker: Worker | null = null
    let engineLoaded = false
    let busy = false
    let unloadAfterJob = false
    let ownsCapture = false
    // custody token of the last successful take whose audio is still on disk;
    // only a draftSave echoing this exact token may delete that audio
    let pendingHandoff: string | null = null
    const ownedDownloads = new Set<string>()
    let jobSeq = 0
    let jobHandler: ((msg: WorkerMsg) => void) | null = null

    const ensureWorker = (): Worker => {
      if (worker) return worker
      worker = new Worker(new URL("./engine-worker.ts", import.meta.url).href)
      worker.onmessage = (event: MessageEvent<WorkerMsg>) => jobHandler?.(event.data)
      const fail = (message: string) => {
        const failed = worker
        worker = null
        engineLoaded = false
        try {
          failed?.terminate()
        } catch {
          // already stopped
        }
        if (busy) jobHandler?.({ type: "error", id: jobSeq, message })
        else log(`engine worker FAILED while idle: ${message}`)
      }
      worker.onerror = (event) => fail(event.message || "worker crashed")
      worker.onmessageerror = () => fail("worker message could not be decoded")
      return worker
    }
    const unloadEngine = () => {
      if (!worker) return
      worker.terminate()
      worker = null
      engineLoaded = false
      busy = false
      jobHandler = null
      log("engine unloaded (worker terminated)")
    }
    const reloadEngineWhenSafe = () => {
      if (busy) {
        unloadAfterJob = true
        return
      }
      unloadEngine()
    }

    // ---- residency: the setting actually runs the clock ----
    let lastUse = Date.now()
    const residencyMinutes = (): number | null => {
      const v = settings.str("residency")
      if (v === "always loaded") return null // never auto-unload
      if (v === "unload after each take") return 0
      const m = v.match(/^(\d+) min$/)
      return m ? Number(m[1]) : 15
    }
    const residencyTick = setInterval(() => {
      const mins = residencyMinutes()
      if (mins === null || mins === 0 || !engineLoaded || busy) return
      if (Date.now() - lastUse > mins * 60_000) {
        log(`residency: idle ${mins} min`)
        unloadEngine()
      }
    }, 30_000)

    // ---- safety net: custody files in the data dir ----
    // audio of the last take is kept only while its transcription has not
    // succeeded; once text exists, the draft file takes over until the form
    // is submitted. One slot each, overwritten per take, deleted on success.
    const safeWav = () => `${settings.dataDir()}/last-take.wav`
    const safeDraft = () => `${settings.dataDir()}/last-draft.txt`
    const safetyOn = () => settings.bool("safetyNet")
    const dropSafe = (path: string) => {
      try {
        unlinkSync(path)
      } catch {
        // nothing stored
      }
    }
    const saveDraft = (text: string): boolean => {
      const tmp = `${safeDraft()}.tmp-${randomUUID()}`
      try {
        mkdirSync(settings.dataDir(), { recursive: true })
        writeFileSync(tmp, text)
        renameSync(tmp, safeDraft())
        return true
      } catch (err) {
        dropSafe(tmp)
        log(`safety net: could not save draft: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    }

    const registration = await ctx.rpc.register(Voice, {
      transcribe: async (input, context) => {
        const { wav, client } = input as { wav: string; client: string }
        if (busy || capture.isRecording()) return context.error("busy", "Voice capture or transcription is already running", {})
        busy = true
        const id = ++jobSeq
        log(`transcribe start (model ${settings.str("model")})`)
        const w = ensureWorker()
        const cleanup = () => {
          busy = false
          jobHandler = null
          if (wav.startsWith(`${tmpdir()}/opencode-voice-`)) {
            try {
              unlinkSync(wav)
            } catch {
              // already gone
            }
          }
          if (unloadAfterJob) {
            unloadAfterJob = false
            queueMicrotask(unloadEngine)
          }
        }
        jobHandler = (msg) => {
          if (msg.type === "log") {
            log(msg.line)
            return
          }
          if (msg.id !== id) return
          if (msg.type === "progress") {
            void registration.events.emit("progress", { client, processedSec: msg.processedSec, totalSec: msg.totalSec })
          } else if (msg.type === "done") {
            engineLoaded = true
            lastUse = Date.now()
            if (residencyMinutes() === 0) queueMicrotask(() => unloadEngine())
            log(`transcribe ok: ${Math.round(msg.transcribeMs)}ms${msg.wasLoaded ? "" : ` (+${Math.round(msg.loadMs)}ms load)`}`)
            cleanup()
            // Keep the audio until the TUI has raised/combined the draft and
            // draftSave confirms that exact text is durable. This avoids a
            // cross-process gap and preserves prior takes during extension.
            let take = ""
            if (msg.text.trim()) {
              if (safetyOn()) {
                take = randomUUID()
                pendingHandoff = take
              } else {
                pendingHandoff = null
                dropSafe(safeWav())
              }
            } else if (safetyOn()) {
              log("safety net: empty transcript — audio kept")
            } else {
              dropSafe(safeWav())
            }
            void registration.events.emit("result", {
              client,
              text: msg.text,
              loadMs: msg.wasLoaded ? 0 : msg.loadMs,
              transcribeMs: msg.transcribeMs,
              ...(take ? { take } : {}),
            })
          } else if (msg.type === "error") {
            // no preservation step needed: with the safety net on, the take
            // was recorded straight into the slot and cleanup() only unlinks
            // tmpdir paths — failure keeps the audio by default
            log(`transcribe FAILED: ${msg.message}${safetyOn() ? " (audio kept for retry)" : ""}`)
            cleanup()
            pendingHandoff = null
            if (!safetyOn()) dropSafe(safeWav())
            void registration.events.emit("result", { client, error: msg.message })
          }
        }
        w.postMessage({ type: "transcribe", id, wav, settings: settings.current() })
        return {}
      },
      recordStart: async (_input, context) => {
        if (busy) return context.error("busy", "A transcription is already running", {})
        if (pendingHandoff)
          return context.error("busy", "The previous take is not in a draft yet — press the restore key to recover it", {})
        try {
          const started = capture.start()
          ownsCapture = true
          log(`recording started (${started.recorder})`)
          return started
        } catch (err) {
          log(`recording FAILED: ${err instanceof Error ? err.message : String(err)}`)
          if (err instanceof capture.CaptureError && err.kind === "already_recording")
            return context.error("already_recording", "Already recording", {})
          if (err instanceof capture.CaptureError && err.kind === "no_recorder")
            return context.error("no_recorder", "No recorder found", { message: err.message })
          return context.error("capture_failed", "Capture failed", {
            message: err instanceof Error ? err.message : String(err),
          })
        }
      },
      recordStop: async (_input, context) => {
        try {
          const stopped = await capture.stop()
          ownsCapture = false
          return stopped
        } catch (err) {
          if (!capture.isRecording()) ownsCapture = false
          if (err instanceof capture.CaptureError && err.kind === "not_recording")
            return context.error("not_recording", "Not recording", {})
          return context.error("capture_failed", "Capture failed", {
            message: err instanceof Error ? err.message : String(err),
          })
        }
      },
      status: async () => ({
        recording: capture.isRecording(),
        engineLoaded,
        modelInstalled: catalog.installed().has(settings.str("model")),
        ...processStats(),
      }),
      devices: async () => ({ devices: await capture.listDevices(), recorders: capture.recorderStates() }),
      modelsList: async () => ({ json: JSON.stringify(await catalog.list()) }),
      modelDownload: async (input) => {
        const { name } = input as { name: string }
        // A repeated request from this location is already represented by the
        // owned job. Do not let the catalog's deduplicated immediate return
        // clear our cleanup ownership of the real in-flight transfer.
        if (ownedDownloads.has(name)) return {}
        // fire-and-forget: a multi-minute RPC response outlives any HTTP
        // transport; progress AND completion/failure ride the event stream
        log(`download started: ${name}`)
        ownedDownloads.add(name)
        // Event emissions are async. Firing every percentage concurrently can
        // deliver them out of order (e.g. 49 -> 29). Serialize this download's
        // stream so the panel is monotonic; ignore failures after unload.
        let eventChain = Promise.resolve()
        const emitDownload = (data: { name: string; pct: number; error?: string }) => {
          eventChain = eventChain.then(() => registration.events.emit("download", data)).catch(() => {})
        }
        void catalog
          .request(name, (pct) => {
            emitDownload({ name, pct })
          })
          .then(() => log(`download done: ${name}`))
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err)
            log(`download FAILED: ${name}: ${message}`)
            emitDownload({ name, pct: -1, error: message })
          })
          .finally(() => ownedDownloads.delete(name))
        return {}
      },
      modelCancel: async (input) => {
        const { name } = input as { name: string }
        if (catalog.cancel(name)) log(`download cancelled: ${name}`)
        return {}
      },
      modelDelete: async (input) => {
        const { name } = input as { name: string }
        catalog.remove(name)
        return {}
      },
      logGet: async () => ({ json: JSON.stringify(dump()) }),
      settingsGet: async () => ({ json: JSON.stringify(settings.current()) }),
      settingsSet: async (input) => {
        const { json } = input as { json: string }
        const patch = JSON.parse(json) as settings.Settings
        log(`settings: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(", ")}`)
        const next = await settings.update(patch)
        // disabling the safety net must not leave speech at rest on disk
        if ("safetyNet" in patch && String((patch as Record<string, unknown>).safetyNet) === "false") {
          // mid-recording the recorder holds the slot file open — spare it
          if (!capture.isRecording()) dropSafe(safeWav())
          dropSafe(safeDraft())
          pendingHandoff = null
          log("safety net disabled: stored take/draft removed")
        }
        // engine-shaping settings only take effect on a fresh recognizer
        if (Object.keys(patch).some((k) => ["model", "language", "threads", "vadThreshold", "vadMinSilenceSec", "vadMinSpeechSec", "vadMaxSpeechSec", "vadEnabled"].includes(k)))
          reloadEngineWhenSafe()
        return { json: JSON.stringify(next) }
      },
      settingsReset: async () => {
        const next = await settings.reset()
        reloadEngineWhenSafe()
        return { json: JSON.stringify(next) }
      },
      level: async () => ({ level: capture.level(), recording: capture.isRecording() }),
      recordCancel: async () => {
        await capture.cancel()
        ownsCapture = false
        return {}
      },
      clientLog: async (input) => {
        const { line, debug: dbg } = input as { line: string; debug?: boolean }
        if (dbg) debug(`[tui] ${line}`)
        else log(`[tui] ${line}`)
        return {}
      },
      draftSave: async (input) => {
        const { text, take } = input as { text: string; take?: string }
        if (safetyOn()) {
          if (!saveDraft(text)) throw new Error("could not persist safety-net draft")
          // Restoring an older draft, extending a form, or re-saving on submit
          // carries no token and must never release audio it does not cover.
          if (take && take === pendingHandoff) {
            pendingHandoff = null
            dropSafe(safeWav())
          }
        }
        return {}
      },
      draftClear: async () => {
        dropSafe(safeDraft())
        return {}
      },
      recoverPeek: async () => {
        let text = ""
        try {
          text = readFileSync(safeDraft(), "utf8")
        } catch {
          // no draft stored
        }
        const hasDraft = Boolean(text.trim())
        // An active recorder/decoder owns the WAV; never expose a file that is
        // still being written or read as recoverable.
        const hasAudio = !capture.isRecording() && !busy && existsSync(safeWav())
        if (hasDraft && hasAudio) return { kind: "both", text, wav: safeWav() }
        if (hasDraft) return { kind: "draft", text, wav: "" }
        if (hasAudio) return { kind: "audio", text: "", wav: safeWav() }
        return { kind: "none", text: "", wav: "" }
      },
    })

    return async () => {
      clearInterval(residencyTick)
      // A plugin reload while recording must not orphan the recorder process
      // or leave the safety-net WAV open.
      if (ownsCapture) await capture.cancel()
      for (const name of ownedDownloads) catalog.cancel(name)
      ownedDownloads.clear()
      unloadEngine()
    }
  },
})
