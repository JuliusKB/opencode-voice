/**
 * Ceiling splitting: where to cut a phrase that is longer than the decode
 * ceiling, and how to rejoin the pieces' text afterwards. Pure functions over
 * sample arrays and strings; the engine owns the audio, the VAD and the
 * decoder.
 *
 * Why this exists: Whisper decodes at most 30 s, so a VAD phrase above the
 * ceiling is decoded in pieces. Cutting at the single quietest 100 ms often
 * lands inside a word (stop closures and soft syllables are as quiet as a
 * pause); both pieces then decode a fragment of it ("the text. text that"),
 * and Whisper terminates every piece with a period as if it were a full
 * utterance ("childhood. holidays"). So the cut goes into the latest real
 * pause the speech detector reports before the limit, the pieces overlap on
 * that silence only, and a terminator left at a cut is removed when the next
 * piece visibly continues the sentence. An energy-based gap finder was tried
 * (2026-10-23) and dropped: it mistook soft words for silence.
 */

import { MAX_CUT_SILENCE_SEC } from "./tuning"

export type Range = { start: number; end: number }

export type Piece = Range & {
  /** how this piece's end was chosen; "end" = the phrase's own end */
  via: "pause" | "dip" | "end"
}

/** Centre of the quietest `win`-sample window in [from, to); the pre-0.0.9 rule, kept as the fallback. */
export function quietestDip(samples: Float32Array, from: number, to: number, win: number): number {
  if (to - from < win) return to
  let best = to
  let bestEnergy = Number.POSITIVE_INFINITY
  for (let pos = from; pos + win <= to; pos += win) {
    let energy = 0
    for (let i = pos; i < pos + win; i++) energy += samples[i] * samples[i]
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = pos + Math.floor(win / 2)
    }
  }
  return best
}

/**
 * Split one phrase into pieces no longer than `ceilingSec`. `pauses` are the
 * speech detector's silences inside the phrase (sample ranges, ascending).
 * Each cut uses the latest pause that lies entirely within the `searchSec`
 * before the limit: the piece ends where the pause ends and the next piece
 * starts where it starts, so the overlap is silence and no speech is decoded
 * twice. Without such a pause the quietest 100 ms dip in that band is used
 * and the pieces abut.
 */
export function planCuts(samples: Float32Array, rate: number, ceilingSec: number, searchSec: number, pauses: Range[]): Piece[] {
  const limit = Math.floor(ceilingSec * rate)
  if (samples.length <= limit) return [{ start: 0, end: samples.length, via: "end" }]

  const pieces: Piece[] = []
  let offset = 0
  while (samples.length - offset > limit) {
    const limitAt = offset + limit
    // never cut inside the first second of a piece: keeps progress guaranteed
    const bandStart = Math.max(offset + rate, limitAt - Math.floor(searchSec * rate))
    // the latest pause by position (not array order) that lies entirely in the band
    let pause: Range | null = null
    for (const p of pauses)
      if (p.start >= bandStart && p.end <= limitAt && p.end > p.start && (!pause || p.start > pause.start)) pause = p
    if (pause) {
      const maxSilence = Math.floor(MAX_CUT_SILENCE_SEC * rate)
      pieces.push({ start: offset, end: Math.min(pause.end, pause.start + maxSilence), via: "pause" })
      offset = Math.max(pause.start, pause.end - maxSilence)
    } else {
      const dip = quietestDip(samples, bandStart, limitAt, Math.round(0.1 * rate))
      pieces.push({ start: offset, end: dip, via: "dip" })
      offset = dip
    }
  }
  pieces.push({ start: offset, end: samples.length, via: "end" })
  return pieces
}

/** Last tokens after which a period is not a sentence end. */
const ABBREVIATIONS = new Set(["e.g.", "i.e.", "etc.", "vs.", "dr.", "mr.", "mrs.", "ms.", "a.m.", "p.m."])

/**
 * Join the decoded pieces of one phrase. A piece that ends in `.`, `,` or
 * `...` while the next piece starts with a lowercase letter was terminated
 * by the cut, not by the speaker: the terminators are dropped. Uppercase and
 * digits are left alone. Empty pieces, before or after the repair, are
 * skipped. Returns the line and how many pieces were repaired.
 */
export function joinPieces(texts: string[]): { text: string; repairs: number } {
  const parts = texts.map((t) => t.trim()).filter(Boolean)
  let repairs = 0
  for (let i = 0; i + 1 < parts.length; i++) {
    const cur = parts[i]
    const next = parts[i + 1]
    if (!/[.,]$/.test(cur) || !/^\p{Ll}/u.test(next)) continue
    const lastToken = cur.slice(cur.lastIndexOf(" ") + 1).toLowerCase()
    if (ABBREVIATIONS.has(lastToken)) continue
    parts[i] = cur.replace(/[.,\s]+$/, "")
    repairs++
  }
  return { text: parts.filter(Boolean).join(" ").trim(), repairs }
}
