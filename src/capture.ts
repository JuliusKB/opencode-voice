/**
 * Audio capture: spawns the system recorder into a temp WAV.
 *
 * Recorder chain (published requirement): Linux needs nothing —
 * pw-record (PipeWire) or arecord (ALSA) ship with the OS; ffmpeg is the
 * fallback and the planned option for future macOS/Windows support.
 *
 * One capture at a time, enforced here — mirrors the product rule
 * "one transcription at a time, always into the current chat".
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { bool, dataDir, num, str } from "./settings"
import { debug } from "./log"

const BYTES_PER_SECOND = 16000 * 2 // 16kHz mono s16
const WAV_HEADER_BYTES = 44

type Recorder = { name: string; args: (outFile: string) => string[] }

const device = () => str("device")
const RECORDERS: Recorder[] = [
  {
    name: "pw-record",
    args: (f) => [
      "pw-record",
      ...(device() !== "default" ? ["--target", device()] : []),
      "--rate", "16000", "--channels", "1", "--format", "s16", f,
    ],
  },
  {
    name: "arecord",
    args: (f) => [
      "arecord",
      ...(device() !== "default" ? ["-D", device()] : []),
      "-q", "-f", "S16_LE", "-r", "16000", "-c", "1", f,
    ],
  },
  // ffmpeg input device differs per OS; Linux/pulse shown. macOS: -f avfoundation -i :0
  {
    name: "ffmpeg",
    args: (f) => [
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "pulse",
      "-i", device() !== "default" ? device() : "default",
      // flush per packet: ffmpeg otherwise buffers the muxer output and the
      // WAV stays at 0 bytes until exit — level() tail-reads the growing
      // file, so without this the meter is dead under ffmpeg (verified)
      "-ar", "16000", "-ac", "1", "-flush_packets", "1", "-y", f,
    ],
  },
]

/** Enumerate input devices via whatever the system offers. */
export async function listDevices(): Promise<string[]> {
  const out = new Set<string>(["default"])
  if (Bun.which("pactl")) {
    const p = Bun.spawn(["pactl", "list", "short", "sources"], { stdout: "pipe" })
    const text = await new Response(p.stdout).text()
    for (const line of text.split("\n")) {
      const name = line.split("\t")[1]
      if (name && !name.endsWith(".monitor")) out.add(name)
    }
  } else if (Bun.which("arecord")) {
    const p = Bun.spawn(["arecord", "-L"], { stdout: "pipe" })
    const text = await new Response(p.stdout).text()
    for (const line of text.split("\n")) {
      if (/^(plughw|hw|sysdefault):/.test(line)) out.add(line.trim())
    }
  }
  return [...out]
}

let current: { proc: ReturnType<typeof Bun.spawn>; path: string; recorder: string } | null = null

// ---- never leave a microphone open -------------------------------------
// Bun does not kill child processes when the server dies, so a crash, a
// SIGKILL or a hot reload that skips cleanup would orphan the recorder with
// the mic held open indefinitely. Three layers close that:
//   1. the recorder is exec'd under a tiny shell watchdog that kills it as
//      soon as the server process disappears (covers crashes and SIGKILL);
//   2. a normal process exit kills it directly;
//   3. start() and plugin setup sweep recorders from an earlier server that
//      still target our own output files (belt and braces for 1).
const slotPrefixes = () => [`${dataDir()}/last-take.wav`, `${tmpdir()}/opencode-voice-`]

// $1 = server pid, $$ = our pid (kept across exec). The background loop
// exits on its own once either the server or the recorder is gone.
const WATCHDOG =
  'P=$1; R=$$; shift; ( while kill -0 "$P" 2>/dev/null && kill -0 "$R" 2>/dev/null; do sleep 1; done; ' +
  'kill -0 "$R" 2>/dev/null && kill -TERM "$R" 2>/dev/null ) & exec "$@"'

function guarded(args: string[]): string[] {
  if (process.platform === "win32" || !Bun.which("sh")) return args
  return ["sh", "-c", WATCHDOG, "sh", String(process.pid), ...args]
}

/** Kill recorder processes left behind by a previous server that died mid-take. */
export function sweepStale(): number {
  if (process.platform === "win32" || !Bun.which("pgrep")) return 0
  const p = Bun.spawnSync(["pgrep", "-a", "-f", "pw-record|arecord|ffmpeg"], { stdout: "pipe", stderr: "ignore" })
  if (!p.success) return 0
  const own = current?.proc.pid
  let killed = 0
  for (const line of p.stdout.toString().split("\n")) {
    const pid = Number(line.split(" ", 1)[0])
    if (!pid || pid === own) continue
    if (!slotPrefixes().some((prefix) => line.includes(prefix))) continue
    try {
      process.kill(pid, "SIGKILL")
      killed++
    } catch {
      // already gone
    }
  }
  if (killed) debug(`capture: killed ${killed} stale recorder process(es) from a previous server`)
  return killed
}

process.on("exit", () => {
  if (!current) return
  try {
    current.proc.kill("SIGKILL")
  } catch {
    // already gone
  }
})

// which tools even make sense per OS (pw-record/arecord are Linux audio
// stacks; ffmpeg is the cross-platform fallback)
const TOOL_PLATFORMS: Record<string, string[]> = {
  "pw-record": ["linux"],
  arecord: ["linux"],
  ffmpeg: ["linux", "darwin", "win32"],
}

export type RecorderState = "ok" | "not installed" | "not available"

export function recorderStates(): Array<{ name: string; state: RecorderState }> {
  return RECORDERS.map((r) => ({
    name: r.name,
    state: !(TOOL_PLATFORMS[r.name] ?? []).includes(process.platform)
      ? ("not available" as const)
      : Bun.which(r.name)
        ? ("ok" as const)
        : ("not installed" as const),
  }))
}

function detectRecorder(): Recorder | null {
  const preferred = str("recorder")
  const chain = preferred === "auto" ? RECORDERS : RECORDERS.filter((r) => r.name === preferred)
  for (const r of chain) if (Bun.which(r.name)) return r
  return null
}

export function isRecording(): boolean {
  return current !== null
}

export function start(): { recorder: string } {
  if (current) throw new CaptureError("already_recording")
  const recorder = detectRecorder()
  if (!recorder) throw new CaptureError("no_recorder", "no recorder found (tried pw-record, arecord, ffmpeg)")
  // safety net: record STRAIGHT into the data-dir slot — preservation is the
  // passive state, deletion (on transcribe success) the explicit act, so any
  // crash at any point defaults to keeping the audio. Net off = volatile tmp.
  let path: string
  if (bool("safetyNet")) {
    mkdirSync(dataDir(), { recursive: true })
    path = `${dataDir()}/last-take.wav`
  } else {
    path = `${tmpdir()}/opencode-voice-${Date.now()}.wav`
  }
  sweepStale()
  const proc = Bun.spawn(guarded(recorder.args(path)), { stdout: "ignore", stderr: "pipe" })
  current = { proc, path, recorder: recorder.name }
  return { recorder: recorder.name }
}

export async function stop(): Promise<{ wav: string; seconds: number }> {
  if (!current) throw new CaptureError("not_recording")
  const { proc, path } = current
  current = null
  proc.kill("SIGINT") // lets the recorder finalize the WAV header
  await proc.exited
  if (!existsSync(path)) throw new CaptureError("capture_failed", "recorder produced no file")
  const bytes = statSync(path).size
  if (bytes <= WAV_HEADER_BYTES) {
    unlinkSync(path)
    throw new CaptureError("capture_failed", "recording is empty")
  }
  debug(`capture stopped: ${bytes} bytes, ${((bytes - WAV_HEADER_BYTES) / BYTES_PER_SECOND).toFixed(1)}s`)
  return { wav: path, seconds: (bytes - WAV_HEADER_BYTES) / BYTES_PER_SECOND }
}

export async function cancel(): Promise<void> {
  if (!current) return
  const { proc, path } = current
  current = null
  proc.kill("SIGKILL")
  await proc.exited
  try {
    unlinkSync(path)
  } catch {
    // already gone — nothing to clean
  }
}

/**
 * Loudness of the most recent slice of the in-progress recording, 0..1.
 * Reads the tail of the growing WAV directly — no extra process, no stream
 * plumbing. Returns 0 when nothing is being recorded yet.
 */
const LEVEL_WINDOW_BYTES = 3200 // ~100ms of 16kHz mono s16

export function level(): number {
  if (!current) return 0
  let fd: number | undefined
  try {
    const size = statSync(current.path).size
    if (size <= WAV_HEADER_BYTES) return 0
    const want = Math.min(LEVEL_WINDOW_BYTES, size - WAV_HEADER_BYTES)
    const buf = Buffer.allocUnsafe(want - (want % 2))
    fd = openSync(current.path, "r")
    readSync(fd, buf, 0, buf.length, size - buf.length)
    let sum = 0
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const sample = buf.readInt16LE(i) / 32768
      sum += sample * sample
    }
    const rms = Math.sqrt(sum / (buf.length / 2))
    // speech RMS is small; scale so normal talking lands mid-strip
    if (rms < num("meterFloor")) return 0
    return Math.max(0, Math.min(1, rms * num("meterGain")))
  } catch {
    return 0
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export class CaptureError extends Error {
  constructor(
    readonly kind: "already_recording" | "not_recording" | "no_recorder" | "capture_failed",
    message?: string,
  ) {
    super(message ?? kind)
  }
}
