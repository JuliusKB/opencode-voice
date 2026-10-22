import { describe, expect, test } from "bun:test"
import { joinPieces, planCuts, quietestDip, type Range } from "../src/split"

const RATE = 16000
const sec = (s: number) => Math.round(s * RATE)

/** Deterministic noise with room-tone holes at the given [start, length] seconds. */
function signal(seconds: number, holes: Array<[number, number]> = []): Float32Array {
  const out = new Float32Array(sec(seconds))
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.6
  for (const [at, len] of holes) for (let i = sec(at); i < Math.min(out.length, sec(at + len)); i++) out[i] = rnd() * 0.0006
  return out
}
const pauses = (list: Array<[number, number]>): Range[] => list.map(([at, len]) => ({ start: sec(at), end: sec(at + len) }))

describe("planCuts", () => {
  test("short phrase is one piece", () => {
    expect(planCuts(signal(10), RATE, 25, 8, pauses([[5, 0.5]]))).toEqual([{ start: 0, end: sec(10), via: "end" }])
  })

  test("cuts in the latest pause inside the band and overlaps on silence only", () => {
    const s = signal(40)
    const p = pauses([
      [10, 0.5], // before the band
      [18, 0.3],
      [23.5, 0.3], // the one to pick for the limit at 25 s
      [24.9, 0.3], // crosses the limit: not entirely inside
    ])
    const pieces = planCuts(s, RATE, 25, 8, p)
    expect(pieces).toEqual([
      { start: 0, end: sec(23.8), via: "pause" },
      { start: sec(23.5), end: sec(40), via: "end" },
    ])
  })

  test("keeps at most 0.5 s of a long pause on either side of the cut", () => {
    const s = signal(40)
    const pieces = planCuts(s, RATE, 25, 8, pauses([[20, 4]])) // 4 s of silence, e.g. VAD line-splitting off
    expect(pieces[0].end).toBe(sec(20.5))
    expect(pieces[1].start).toBe(sec(23.5))
  })

  test("latest by position even when pauses are unsorted; a pause ending exactly at the limit counts", () => {
    const s = signal(40)
    const pieces = planCuts(s, RATE, 25, 8, pauses([[24.7, 0.3], [18, 0.3], [21, 0.2]]))
    expect(pieces[0]).toEqual({ start: 0, end: sec(25), via: "pause" })
    expect(pieces[1].start).toBe(sec(24.7))
  })

  test("zero-length pauses and a zero search band never cut on a pause", () => {
    const s = signal(40)
    expect(planCuts(s, RATE, 25, 8, [{ start: sec(22), end: sec(22) }])[0].via).toBe("dip")
    expect(planCuts(s, RATE, 25, 0, pauses([[22, 0.3]]))[0].via).toBe("dip")
  })

  test("falls back to the quietest dip without a usable pause", () => {
    const s = signal(60, [[22, 0.1], [47, 0.1]])
    const pieces = planCuts(s, RATE, 25, 8, [])
    expect(pieces.map((p) => p.via)).toEqual(["dip", "dip", "end"])
    expect(pieces[0].end / RATE).toBeCloseTo(22.05, 1)
    for (let i = 0; i + 1 < pieces.length; i++) expect(pieces[i + 1].start).toBe(pieces[i].end) // abutting
    for (const p of pieces) expect(p.end - p.start).toBeLessThanOrEqual(sec(25))
    expect(pieces[pieces.length - 1].end).toBe(s.length)
  })

  test("a pause in the first second of a piece is never used", () => {
    const s = signal(30)
    const pieces = planCuts(s, RATE, 25, 29, pauses([[0.2, 0.5]]))
    expect(pieces[0].via).toBe("dip")
    expect(pieces[1].start).toBeGreaterThanOrEqual(RATE)
  })

  test("every piece stays under the ceiling and the phrase is covered", () => {
    const s = signal(100)
    // limits fall at 25, 45, 69, 91 s; bands are the 8 s before each
    const p = pauses([[20, 0.4], [44, 0.25], [45.5, 0.3], [66, 0.5], [88, 0.3]])
    const pieces = planCuts(s, RATE, 25, 8, p)
    expect(pieces[0].start).toBe(0)
    expect(pieces[pieces.length - 1].end).toBe(s.length)
    for (let i = 0; i + 1 < pieces.length; i++) {
      expect(pieces[i + 1].start).toBeLessThanOrEqual(pieces[i].end)
      expect(pieces[i + 1].start).toBeGreaterThan(pieces[i].start)
    }
    for (const p of pieces) expect(p.end - p.start).toBeLessThanOrEqual(sec(25))
    expect(pieces.map((p) => p.via)).toEqual(["pause", "pause", "pause", "pause", "end"])
  })
})

describe("quietestDip", () => {
  test("finds the quiet window", () => {
    const s = signal(5, [[3.0, 0.1]])
    expect(quietestDip(s, RATE, sec(5), 1600) / RATE).toBeCloseTo(3.05, 1)
  })
  test("returns the end when the band is too short", () => {
    expect(quietestDip(signal(1), 100, 200, 1600)).toBe(200)
  })
})

describe("joinPieces", () => {
  test("drops a terminator before a lowercase continuation", () => {
    expect(joinPieces(["reading the text.", "that has been laid out"])).toEqual({ text: "reading the text that has been laid out", repairs: 1 })
    expect(joinPieces(["after this,", "recording is complete."]).text).toBe("after this recording is complete.")
  })
  test("drops a whole ellipsis and a piece that was only punctuation", () => {
    expect(joinPieces(["and then the...", "rest of it"])).toEqual({ text: "and then the rest of it", repairs: 1 })
    expect(joinPieces(["one.", ".", "two"]).text).toBe("one. two")
    expect(joinPieces(["one,", ".", "two"]).text).toBe("one, two")
  })
  test("keeps real sentence ends", () => {
    expect(joinPieces(["Done.", "Next one."])).toEqual({ text: "Done. Next one.", repairs: 0 })
    expect(joinPieces(["ending at 3.", "5 percent"]).repairs).toBe(0)
  })
  test("keeps abbreviations", () => {
    expect(joinPieces(["use e.g.", "this one"]).text).toBe("use e.g. this one")
    expect(joinPieces(["at 5 p.m.", "we leave"]).repairs).toBe(0)
  })
  test("skips empty pieces and handles non-Latin scripts", () => {
    expect(joinPieces(["", "one.", "", "two"]).text).toBe("one two")
    expect(joinPieces(["одно.", "два"]).text).toBe("одно два")
    // Georgian Mkhedruli is Unicode-lowercase (Mtavruli capitals exist but
    // Whisper never emits them), so a cut terminator is dropped there too
    expect(joinPieces(["ერთი.", "ორი"]).text).toBe("ერთი ორი")
  })
})
