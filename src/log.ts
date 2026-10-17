/**
 * Plugin log: in-memory ring buffer (TUI log page) mirrored to a plain file.
 *
 * Retention: exactly two files. Each new opencode-server RUN rotates
 * voice.log -> voice.log.prev (overwriting) and starts a fresh current.
 * Hot reloads within one run keep appending. No further management.
 * Debug lines (gated by the debugLog setting) add pipeline internals:
 * timings, VAD segmentation, chunk decodes. NEVER speech content — no
 * transcript text, no form text, under any level.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { bool, dataDir } from "./settings"

const MAX_LINES = 500
const lines: string[] = []
let filePath: string | null = null

export function init(): void {
  try {
    mkdirSync(dataDir(), { recursive: true })
    filePath = `${dataDir()}/voice.log`
    // rotate per opencode-server RUN; plugin (hot) reloads keep appending —
    // a reload wiping the file destroys exactly the evidence being debugged
    const serverStartMs = Date.now() - process.uptime() * 1000
    let sameRun = false
    try {
      sameRun = statSync(filePath).mtimeMs > serverStartMs
    } catch {
      sameRun = false
    }
    if (!sameRun) {
      try {
        renameSync(filePath, `${filePath}.prev`)
      } catch {
        // no previous current — first run ever
      }
      writeFileSync(filePath, "")
    }
    log(sameRun ? "log continued (plugin reloaded)" : "log started (previous run in voice.log.prev)")
  } catch {
    filePath = null // in-memory only; the page will say so
    log("log: file unavailable, in-memory only")
  }
}

function write(line: string): void {
  lines.push(line)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  if (filePath) {
    try {
      appendFileSync(filePath, `${line}\n`)
    } catch {
      filePath = null
    }
  }
}

export function log(message: string): void {
  const t = new Date()
  const stamp = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`
  write(`${stamp} ${message}`)
}

/** Verbose internals; no-op unless the debugLog setting is on. */
export function debug(message: string): void {
  if (!bool("debugLog")) return
  log(`[debug] ${message}`)
}

export function dump(file: "current" | "previous" = "current"): { path: string | null; lines: string[] } {
  const path = file === "previous" && filePath ? `${filePath}.prev` : filePath
  if (!path) return { path: null, lines: [...lines] }
  try {
    return { path, lines: readFileSync(path, "utf8").split("\n").filter(Boolean) }
  } catch {
    return file === "previous"
      ? { path, lines: ["(no previous log file)"] }
      : { path: null, lines: [...lines] }
  }
}
