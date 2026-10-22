/**
 * Model catalog: the curated list of downloadable whisper models, plus
 * install/remove management. Downloads are k2-fsa's release tarballs;
 * after extraction only the int8 ONNX + tokens are kept (fp32 variants and
 * test wavs are dead weight — observed 1.5G -> 457M on this machine).
 *
 * Nothing is ever downloaded without an explicit user action.
 */
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { dataDir } from "./settings"

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"

/** The members kept from a model tarball; everything else (fp32 weights, test wavs) is dead weight. */
const KEEP_PATTERNS = ["*.int8.onnx", "*-tokens.txt"]
const keep = (f: string) => f.endsWith(".int8.onnx") || f.endsWith("-tokens.txt")

/**
 * A 192-byte .tar.bz2 holding x/a.int8.onnx, x/b-tokens.txt, x/c.onnx. Extracting
 * it proves, before any large download, that this machine's tar exists, can
 * read bzip2, and (ideally) can select members, which halves peak disk use.
 */
const PROBE_TAR_BZ2 =
  "QlpoOTFBWSZTWWvAvgQAAPz7hMmAAMBAA//AGEF6KZ5AAACACDAArNCSoAAAaAAAJUIyAABoANNAVRQQ00AaAZAGn3aPSWZVug8kLTXVwiSQJjL2NqOcCUKWJsLBcWqCCkiYUnwoNerps+3GaLCHUkGGGHfSRsynClmlMOsSrmOBRUTEVzUVBoTtWDAYlaIkKWrNIH2sAKUlLunod68jWbgZBeWnwy4lZ2kpvP2fEqY7rWqSD+LuSKcKEg14F8CA"

type TarProbe = { ok: true; selective: boolean } | { ok: false; problem: string }
let tarProbe: Promise<TarProbe> | null = null

async function tryExtract(archive: string, into: string, selective: boolean): Promise<string | null> {
  mkdirSync(into, { recursive: true })
  const args = ["tar", "xjf", archive, "-C", into, "--strip-components=1", ...(selective ? ["--wildcards", ...KEEP_PATTERNS] : [])]
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" })
  const code = await proc.exited
  const err = (await new Response(proc.stderr).text()).trim()
  if (code !== 0) return err || `tar exited with ${code}`
  const have = (f: string) => existsSync(`${into}/${f}`)
  if (!have("a.int8.onnx") || !have("b-tokens.txt")) return "tar extracted nothing usable"
  if (selective && have("c.onnx")) return "tar ignored the member selection"
  return null
}

/** Once per server: can tar here read .tar.bz2, and can it extract selected members? */
export function probeTar(): Promise<TarProbe> {
  if (tarProbe) return tarProbe
  tarProbe = (async (): Promise<TarProbe> => {
    if (!Bun.which("tar")) return { ok: false, problem: "tar is not installed. Install it (e.g. sudo apt install tar) and try again." }
    const work = `${modelsDir()}/.tar-probe-${randomUUID()}`
    try {
      mkdirSync(work, { recursive: true })
      const archive = `${work}/probe.tar.bz2`
      writeFileSync(archive, Buffer.from(PROBE_TAR_BZ2, "base64"))
      if ((await tryExtract(archive, `${work}/selective`, true)) === null) return { ok: true, selective: true }
      const plain = await tryExtract(archive, `${work}/plain`, false)
      if (plain === null) return { ok: true, selective: false }
      const bz = /bzip2|bunzip2|Cannot exec|not found|Child returned/i.test(plain)
      return {
        ok: false,
        problem: bz
          ? "tar cannot read .tar.bz2 archives here. Install bzip2 (e.g. sudo apt install bzip2) and try again."
          : `tar failed on a test archive: ${plain.split("\n")[0]}`,
      }
    } catch (err) {
      return { ok: false, problem: `could not test tar: ${(err as Error).message}` }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })()
  return tarProbe
}

export type Preflight = {
  /** peak disk use during install, MB: tarball + extracted members (+ a margin) */
  needMb: number
  /** free space in the model directory, MB; null when it cannot be read */
  freeMb: number | null
  dir: string
  /** hard stops, each one sentence naming what to fix; empty when the download can start */
  problems: string[]
}

/**
 * Checks run before a download is offered: a writable model directory, a tar
 * that can read the archive, and how much room the install needs versus what
 * is free. Space is reported, not enforced: free-space figures can be wrong on
 * network and overlay filesystems, so the UI asks instead of refusing.
 */
export async function preflight(name: string): Promise<Preflight> {
  assertName(name)
  const dir = modelsDir()
  const problems: string[] = []
  try {
    mkdirSync(dir, { recursive: true })
    const probe = `${dir}/.write-probe-${randomUUID()}`
    writeFileSync(probe, "")
    rmSync(probe, { force: true })
  } catch (err) {
    problems.push(`The model directory ${dir} is not writable: ${(err as Error).message}`)
  }
  const tar = problems.length ? null : await probeTar()
  if (tar && !tar.ok) problems.push(tar.problem)
  let freeMb: number | null = null
  try {
    const s = statfsSync(dir)
    freeMb = Math.floor((Number(s.bavail) * Number(s.bsize)) / 1024 / 1024)
  } catch {
    freeMb = null
  }
  const entry = ((await fetchRemote()) ?? CATALOG).find((e) => e.name === name)
  const downloadMb = entry?.downloadMb ?? 0
  // observed for small.en: 606 MB tarball, 1.5 GB fully extracted, 457 MB kept
  const factor = tar && tar.ok && tar.selective ? 1.8 : 3.5
  const needMb = Math.round(downloadMb * factor) + 100
  return { needMb, freeMb, dir, problems }
}

export interface CatalogEntry {
  name: string
  downloadMb: number
  note: string
}

/** Curated subset; honest size = tarball download size. */
export const CATALOG: CatalogEntry[] = [
  { name: "tiny.en", downloadMb: 112, note: "fastest · occasional mishears · English" },
  { name: "tiny", downloadMb: 110, note: "fastest · multilingual" },
  { name: "base.en", downloadMb: 198, note: "quick · decent · English" },
  { name: "base", downloadMb: 197, note: "quick · decent · multilingual" },
  { name: "small.en", downloadMb: 606, note: "recommended · English" },
  { name: "small", downloadMb: 609, note: "accurate · multilingual" },
  { name: "distil-small.en", downloadMb: 432, note: "near-small quality, faster · English" },
  { name: "medium.en", downloadMb: 1817, note: "slow · very accurate · English" },
  { name: "medium", downloadMb: 1841, note: "slow · very accurate · multilingual" },
  { name: "turbo", downloadMb: 537, note: "large-v3 distilled · multilingual" },
]

const modelsDir = () => `${dataDir()}/models`
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function validName(name: string): boolean {
  return SAFE_NAME.test(name) && name !== "." && name !== ".."
}

function assertName(name: string): void {
  if (!validName(name)) throw new Error("invalid model name")
}

const dirFor = (name: string) => {
  assertName(name)
  const root = resolve(modelsDir())
  const dir = resolve(root, `sherpa-onnx-whisper-${name}`)
  if (!dir.startsWith(`${root}${sep}`)) throw new Error("model path escapes model directory")
  return dir
}

function complete(name: string): boolean {
  if (!validName(name)) return false
  const dir = dirFor(name)
  return (
    existsSync(`${dir}/${name}-encoder.int8.onnx`) &&
    existsSync(`${dir}/${name}-decoder.int8.onnx`) &&
    existsSync(`${dir}/${name}-tokens.txt`)
  )
}

export function installed(): Set<string> {
  try {
    return new Set(
      readdirSync(modelsDir())
        .filter((d) => d.startsWith("sherpa-onnx-whisper-"))
        .map((d) => d.replace("sherpa-onnx-whisper-", ""))
        .filter(complete),
    )
  } catch {
    return new Set()
  }
}

// Live catalog: the k2-fsa release's asset list, refreshed at most once per
// day, merged with the curated notes above. Offline (or API failure) falls
// back to the baked-in list — the plugin never depends on the network.
let remote: { at: number; entries: CatalogEntry[] } | null = null
const REMOTE_TTL_MS = 24 * 60 * 60 * 1000

async function fetchRemote(): Promise<CatalogEntry[] | null> {
  if (remote && Date.now() - remote.at < REMOTE_TTL_MS) return remote.entries
  try {
    const res = await fetch("https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/asr-models", {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return remote?.entries ?? null
    const data = (await res.json()) as { assets?: Array<{ name: string; size: number }> }
    const entries: CatalogEntry[] = []
    for (const a of data.assets ?? []) {
      const m = a.name.match(/^sherpa-onnx-whisper-(.+)\.tar\.bz2$/)
      if (!m) continue
      const name = m[1]
      if (!validName(name)) continue
      const curated = CATALOG.find((e) => e.name === name)
      entries.push({
        name,
        downloadMb: Math.round(a.size / 1024 / 1024),
        note: curated?.note ?? "",
      })
    }
    if (entries.length > 0) remote = { at: Date.now(), entries }
    return remote?.entries ?? null
  } catch {
    return remote?.entries ?? null
  }
}

export type ModelStatus = "installed" | "downloading" | "queued" | "available"

export async function list(): Promise<Array<CatalogEntry & { status: ModelStatus }>> {
  const have = installed()
  const st = status()
  const statusOf = (name: string): ModelStatus =>
    have.has(name) ? "installed" : st.downloading === name ? "downloading" : st.queued.includes(name) ? "queued" : "available"
  const source = (await fetchRemote()) ?? CATALOG
  // curated order first, discoveries after, local-only models last
  const curatedOrder = new Map(CATALOG.map((e, i) => [e.name, i]))
  const entries = [...source].sort(
    (a, b) => (curatedOrder.get(a.name) ?? 99) - (curatedOrder.get(b.name) ?? 99) || a.name.localeCompare(b.name),
  )
  const known = entries.map((e) => ({ ...e, status: statusOf(e.name) }))
  for (const name of have)
    if (!known.some((e) => e.name === name))
      known.push({ name, downloadMb: 0, note: "local (not in catalog)", status: "installed" as ModelStatus })
  return known
}

export function remove(name: string): void {
  assertName(name)
  rmSync(dirFor(name), { recursive: true, force: true })
}

// ---- download queue: one transfer at a time, others wait ------------------

export type Stage = "downloading" | "extracting" | "verifying"
export type OnProgress = (pct: number, stage: Stage) => void
type Job = { name: string; onProgress: OnProgress; done: (err?: Error) => void }
let active: { name: string; abort: AbortController } | null = null
const queue: Job[] = []

export function status(): { downloading: string | null; queued: string[] } {
  return { downloading: active?.name ?? null, queued: queue.map((j) => j.name) }
}

/** Cancel a queued or in-flight download. */
export function cancel(name: string): boolean {
  if (!validName(name)) return false
  const qi = queue.findIndex((j) => j.name === name)
  if (qi >= 0) {
    const [job] = queue.splice(qi, 1)
    job.done(new Error("cancelled"))
    return true
  }
  if (active?.name === name) {
    active.abort.abort()
    return true
  }
  return false
}

/** Enqueue a download; resolves when THIS model finishes (or fails). */
export function request(name: string, onProgress: OnProgress): Promise<void> {
  assertName(name)
  if (active?.name === name || queue.some((j) => j.name === name) || installed().has(name))
    return Promise.resolve()
  return new Promise((resolve, reject) => {
    queue.push({ name, onProgress, done: (err) => (err ? reject(err) : resolve()) })
    void pump()
  })
}

async function pump(): Promise<void> {
  if (active) return
  const job = queue.shift()
  if (!job) return
  try {
    await download(job.name, job.onProgress)
    job.done()
  } catch (err) {
    job.done(err instanceof Error ? err : new Error(String(err)))
  } finally {
    void pump()
  }
}

async function download(name: string, onProgress: OnProgress): Promise<void> {
  assertName(name)
  const abort = new AbortController()
  active = { name, abort }
  const tmpTar = `${modelsDir()}/.${name}.tar.bz2`
  const stage = `${modelsDir()}/.extract-${name}-${randomUUID()}`
  try {
    mkdirSync(modelsDir(), { recursive: true })
    // a tar that cannot read the archive fails here, before the transfer
    const tar = await probeTar()
    if (!tar.ok) throw new Error(tar.problem)
    const onPct = (pct: number) => onProgress(pct, "downloading")
    const res = await fetch(`${RELEASE}/sherpa-onnx-whisper-${name}.tar.bz2`, { signal: abort.signal })
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
    const total = Number(res.headers.get("content-length") ?? 0)
    const file = Bun.file(tmpTar).writer()
    let got = 0
    let lastPct = -1
    for await (const chunk of res.body) {
      file.write(chunk)
      got += chunk.byteLength
      if (total > 0) {
        const pct = Math.floor((got / total) * 95) // extraction is the last 5%
        if (pct !== lastPct) {
          lastPct = pct
          onPct(pct)
        }
      }
    }
    await file.end()
    abort.signal.throwIfAborted()

    onProgress(95, "extracting")
    mkdirSync(stage, { recursive: true })
    // selective: only the kept members leave the archive (half the peak disk use, half the time)
    const args = ["tar", "xjf", tmpTar, "-C", stage, "--strip-components=1", ...(tar.selective ? ["--wildcards", ...KEEP_PATTERNS] : [])]
    const extract = Bun.spawn(args, { stderr: "pipe" })
    const stopExtract = () => extract.kill("SIGTERM")
    abort.signal.addEventListener("abort", stopExtract, { once: true })
    const extractExit = await extract.exited
    abort.signal.removeEventListener("abort", stopExtract)
    abort.signal.throwIfAborted()
    if (extractExit !== 0)
      throw new Error(`extraction failed: ${await new Response(extract.stderr).text()}`)
    onProgress(98, "verifying")

    // keep int8 + tokens only (a no-op after a selective extraction)
    for (const f of readdirSync(stage)) if (!keep(f)) rmSync(`${stage}/${f}`, { recursive: true, force: true })
    for (const file of [`${name}-encoder.int8.onnx`, `${name}-decoder.int8.onnx`, `${name}-tokens.txt`])
      if (!existsSync(`${stage}/${file}`)) throw new Error(`downloaded model is incomplete: missing ${file}`)
    abort.signal.throwIfAborted()
    // The VAD model is part of a complete first model install. Fetch it before
    // publishing the staged model so a transient failure cannot leave a
    // seemingly ready installation without pause/silence detection.
    const vad = `${modelsDir()}/silero_vad.onnx`
    if (!existsSync(vad)) {
      const vr = await fetch(`${RELEASE}/silero_vad.onnx`, { signal: abort.signal })
      if (!vr.ok) throw new Error(`VAD download failed: HTTP ${vr.status}`)
      const vadTmp = `${vad}.tmp-${randomUUID()}`
      try {
        await Bun.write(vadTmp, await vr.arrayBuffer())
        renameSync(vadTmp, vad)
      } finally {
        rmSync(vadTmp, { force: true })
      }
    }
    abort.signal.throwIfAborted()
    const finalDir = dirFor(name)
    rmSync(finalDir, { recursive: true, force: true })
    renameSync(stage, finalDir)
    onProgress(100, "verifying")
  } finally {
    rmSync(tmpTar, { force: true })
    rmSync(stage, { recursive: true, force: true })
    active = null
  }
}
