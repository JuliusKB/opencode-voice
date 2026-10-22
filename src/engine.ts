/**
 * Transcription engine: sherpa-onnx (in-process, prebuilt npm addon).
 *
 * Pipeline per take:
 *   1. VAD (Silero) splits the waveform into speech segments at real pauses.
 *      This is what OpenAI's python library did internally via decoder
 *      segments, and it is why dictation used to come back one line per
 *      utterance. Silence is never sent to the model.
 *   2. Any segment still longer than the engine's hard ceiling is chunked at
 *      its quietest point (safety net — sherpa's offline whisper decodes at
 *      most 30s per stream and silently discards the rest).
 *   3. Each piece is decoded; segments become LINES, chunks inside one
 *      segment are joined with a space.
 *
 * The recognizer and VAD are created lazily and cached according to the
 * configured residency policy. Models are whisper ONNX int8 directories as
 * shipped by k2-fsa.
 */
import sherpa from "sherpa-onnx-node"
import { bool, dataDir, num, str } from "./settings"
import { fillerSet, isFillerOnly } from "./cleanup"
import { joinPieces, planCuts, type Range } from "./split"

// inside the worker there is no server log; lines are posted to the parent
const post = (line: string) => {
  try {
    ;(globalThis as unknown as Worker).postMessage({ type: "log", line })
  } catch {
    // not in a worker (direct use, e.g. dev scripts): stay silent
  }
}
const log = (m: string) => post(m)
const debug = (m: string) => {
  if (bool("debugLog")) post(`[debug] ${m}`)
}

// every tunable comes from settings; only physical constants live here
const SAMPLE_RATE = 16000 // whisper's required input rate
const VAD_WINDOW = 512 // samples per Silero frame at 16kHz

const models = () => `${dataDir()}/models`
const modelName = () => {
  const name = str("model")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "." || name === "..")
    throw new Error("invalid model name")
  return name
}
const modelDir = () => `${models()}/sherpa-onnx-whisper-${modelName()}`
const vadModel = () => `${models()}/silero_vad.onnx`

type Recognizer = {
  createStream(): unknown
  decode(stream: unknown): void
  getResult(stream: unknown): { text: string }
}

type VadHandle = {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(): { start: number; samples: Float32Array }
  pop(): void
  clear(): void
  reset(): void
  flush(): void
}

let recognizer: Recognizer | null = null
let vad: VadHandle | null = null
let lastLoadMs = 0

const multilingual = () => !modelName().endsWith(".en")

function load(): Recognizer {
  if (recognizer) return recognizer
  const t0 = performance.now()
  // language only exists for multilingual models; "auto" = let whisper detect
  const lang = multilingual() && str("language") !== "auto" ? str("language") : ""
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: `${modelDir()}/${modelName()}-encoder.int8.onnx`,
        decoder: `${modelDir()}/${modelName()}-decoder.int8.onnx`,
        language: lang,
        task: "transcribe",
      },
      tokens: `${modelDir()}/${modelName()}-tokens.txt`,
      numThreads: num("threads"),
    },
  }) as Recognizer
  lastLoadMs = performance.now() - t0
  log(`engine loaded: ${modelName()} in ${Math.round(lastLoadMs)}ms (${num("threads")} threads${multilingual() ? `, language: ${str("language")}` : ""})`)
  return recognizer
}

function loadVad(): VadHandle | null {
  if (vad) return vad
  if (!bool("vadEnabled")) return null
  try {
    vad = new sherpa.Vad(
      {
        sileroVad: {
          model: vadModel(),
          threshold: num("vadThreshold"),
          minSilenceDuration: num("vadMinSilenceSec"), // pause that ends an utterance
          minSpeechDuration: num("vadMinSpeechSec"),
          maxSpeechDuration: num("vadMaxSpeechSec"),
          windowSize: VAD_WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
      },
      // buffer must hold the longest utterance VAD may emit
      num("vadMaxSpeechSec") + 5,
    ) as VadHandle
  } catch {
    vad = null // VAD model missing/unloadable: fall back to plain chunking
  }
  return vad
}

/**
 * A second, finer Silero pass that reports pauses of >= 0.25 s inside one
 * phrase. Used only to place ceiling cuts, so it is loaded on the first
 * phrase that exceeds the ceiling and is independent of `vadEnabled` (which
 * governs line splitting). Unavailable model: no pauses, cuts fall back to
 * the quietest dip.
 */
const PAUSE_MIN_SILENCE = 0.25
const PAUSE_MIN_SPEECH = 0.1
let pauseVad: VadHandle | null = null
let pauseVadFailed = false
function loadPauseVad(): VadHandle | null {
  if (pauseVad || pauseVadFailed) return pauseVad
  try {
    pauseVad = new sherpa.Vad(
      {
        sileroVad: {
          model: vadModel(),
          threshold: num("vadThreshold"),
          minSilenceDuration: PAUSE_MIN_SILENCE,
          minSpeechDuration: PAUSE_MIN_SPEECH,
          maxSpeechDuration: num("vadMaxSpeechSec"),
          windowSize: VAD_WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
      },
      num("vadMaxSpeechSec") + 5,
    ) as VadHandle
  } catch {
    pauseVadFailed = true
  }
  return pauseVad
}

/** Silences between the detector's sub-segments of one phrase, as sample ranges within it. */
function pausesIn(phrase: Float32Array): Range[] {
  const detector = loadPauseVad()
  if (!detector) return []
  detector.reset()
  const speech: Range[] = []
  const drain = () => {
    while (!detector.isEmpty()) {
      const f = detector.front()
      speech.push({ start: f.start, end: f.start + f.samples.length })
      detector.pop()
    }
  }
  for (let i = 0; i + VAD_WINDOW <= phrase.length; i += VAD_WINDOW) {
    detector.acceptWaveform(phrase.subarray(i, i + VAD_WINDOW) as Float32Array)
    drain()
  }
  detector.flush()
  drain()
  const pauses: Range[] = []
  for (let i = 0; i + 1 < speech.length; i++) pauses.push({ start: speech[i].end, end: speech[i + 1].start })
  return pauses
}

export function isLoaded(): boolean {
  return recognizer !== null
}

/**
 * Drop the native objects so their finalizers can free the model memory.
 * Terminating the worker is NOT enough on the host's Bun (1.4.2): the
 * worker's threads and the model stay resident after terminate(), so the
 * worker lives for the whole server lifetime and unloads in place.
 */
export function unload(): boolean {
  const had = recognizer !== null
  recognizer = null
  vad = null
  try {
    Bun.gc(true)
  } catch {
    // no synchronous gc available: finalizers run on the next collection
  }
  return had
}

/** Speech segments via VAD; null means VAD unavailable, [] means silence. */
function segment(samples: Float32Array): Float32Array[] | null {
  const detector = loadVad()
  if (!detector) return null
  // Each take is independent. clear() only discards completed segments;
  // reset() also clears the native VAD model and circular-buffer state.
  detector.reset()
  const out: Float32Array[] = []
  const drain = () => {
    while (!detector.isEmpty()) {
      out.push(detector.front().samples)
      detector.pop()
    }
  }
  for (let i = 0; i + VAD_WINDOW <= samples.length; i += VAD_WINDOW) {
    detector.acceptWaveform(samples.subarray(i, i + VAD_WINDOW) as Float32Array)
    drain()
  }
  detector.flush()
  drain()
  return out
}

/**
 * Noise-annotation filter. Whisper emits non-speech annotations —
 * "(buzzing)", "[BLANK_AUDIO]", "*groans*", "♪♪" — because sherpa's decode
 * loop implements no token suppression. The reference implementations stop
 * these at GENERATION time by banning delimiter tokens from the logits at
 * every step (never noise vocabulary — pure structure):
 *   openai/whisper  whisper/tokenizer.py  (non_speech_tokens: the symbol list)
 *   openai/whisper  whisper/decoding.py   (SuppressTokens logit filter)
 *   ggml-org/whisper.cpp  src/whisper.cpp (suppress_nst, same list in C++)
 * Post-hoc we see text, not logits, so the same structural idea applies one
 * level up: a chunk that is ENTIRELY delimiter-wrapped spans is an
 * annotation and is dropped; inline stripping stays conservative (only
 * [ALL_CAPS] machine markers and ♪) so real dictated parentheticals survive.
 * Upstream fix (suppress_tokens in sherpa) is on the k2-fsa wishlist.
 */
const ANNOTATION_ONLY = /^(\s*(\([^)]*\)|\[[^\]]*\]|\*[^*]*\*|♪[^♪]*♪|♪+))+\s*$/
const INLINE_MARKERS = /\[[A-Z0-9 _]+\]|♪+/g

function filterAnnotations(text: string): string {
  // "full" | "whole lines only" | "off" (legacy boolean maps true->full)
  const mode = str("filterAnnotations")
  if (mode === "off" || mode === "false") return text
  if (text && ANNOTATION_ONLY.test(text)) {
    debug("annotation filter: dropped an annotation-only chunk")
    return ""
  }
  if (mode === "whole lines only") return text
  const cleaned = text.replace(INLINE_MARKERS, " ").replace(/\s{2,}/g, " ").trim()
  if (cleaned !== text) debug("annotation filter: stripped inline marker(s)")
  return cleaned
}

function decodeChunk(rec: Recognizer, samples: Float32Array): string {
  const stream = rec.createStream() as {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
  }
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
  rec.decode(stream)
  return rec.getResult(stream).text.trim()
}

export async function transcribe(
  wavPath: string,
  onProgress?: (processedSec: number, totalSec: number) => void,
): Promise<{ text: string; loadMs: number; transcribeMs: number }> {
  const wave = sherpa.readWave(wavPath) as { sampleRate: number; samples: Float32Array }
  const samples = wave.samples
  const totalSec = samples.length / SAMPLE_RATE
  const t0 = performance.now()

  // VAD segments become lines; without VAD the whole take is one "segment"
  const segments = segment(samples)
  debug(`vad: ${segments === null ? "off" : segments.length} segment(s) from ${totalSec.toFixed(1)}s audio`)
  if (segments?.length === 0)
    return { text: "", loadMs: 0, transcribeMs: performance.now() - t0 }
  const rec = load()
  // a phrase above the decode ceiling is cut at pauses (split.ts); pieces of
  // one phrase stay one line
  const ceiling = num("ceilingSec")
  const fillers = fillerSet(str("fillerWords"))
  const units = (segments ?? [samples]).map((phrase) => ({
    phrase,
    pieces: planCuts(phrase, SAMPLE_RATE, ceiling, num("splitSearchSec"), phrase.length > ceiling * SAMPLE_RATE ? pausesIn(phrase) : []),
  }))

  const lines: string[] = []
  let processed = 0
  for (const { phrase, pieces } of units) {
    const parts: string[] = []
    for (const piece of pieces) {
      const chunk = phrase.subarray(piece.start, piece.end) as Float32Array
      const c0 = performance.now()
      parts.push(filterAnnotations(decodeChunk(rec, chunk)))
      debug(`chunk: ${(chunk.length / SAMPLE_RATE).toFixed(1)}s decoded in ${Math.round(performance.now() - c0)}ms`)
      if (piece.via !== "end") debug(`ceiling cut via ${piece.via} at ${(piece.end / SAMPLE_RATE).toFixed(2)}s`)
      processed += chunk.length / SAMPLE_RATE
      onProgress?.(Math.min(processed, totalSec), totalSec)
      // decode blocks the loop; yield so the progress event actually flushes
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const { text: line, repairs } = joinPieces(parts)
    if (repairs) debug(`join repair: dropped ${repairs} terminator(s) at ceiling cuts`)
    if (!line) continue
    if (isFillerOnly(line, fillers)) {
      // verbatim on purpose: how a user learns what their model emits for a hesitation
      debug(`filler-only line dropped: "${line}"`)
      continue
    }
    lines.push(line)
  }

  return {
    text: lines.join("\n"),
    loadMs: lastLoadMs,
    transcribeMs: performance.now() - t0,
  }
}
