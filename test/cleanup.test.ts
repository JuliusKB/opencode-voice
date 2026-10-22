import { describe, expect, test } from "bun:test"
import { fillerSet, fillerTokens, isFillerOnly } from "../src/cleanup"
import { DEFAULTS } from "../src/settings"

const fillers = fillerSet(String(DEFAULTS.fillerWords))

describe("fillerTokens", () => {
  test("lowercases, strips punctuation including ellipses, splits", () => {
    expect(fillerTokens("Uh, um... Hmm!")).toEqual(["uh", "um", "hmm"])
    expect(fillerTokens("M…")).toEqual(["m"])
    expect(fillerTokens("")).toEqual([])
  })
})

describe("fillerSet", () => {
  test("parses the comma-separated default", () => {
    expect(fillers.has("uh")).toBe(true)
    expect(fillers.has("m")).toBe(true)
    expect(fillers.has("oh")).toBe(false)
  })
  test("an entry with spaces contributes its words; off disables", () => {
    expect([...fillerSet("äh, ähm , uh huh")]).toEqual(["äh", "ähm", "uh", "huh"])
    expect(fillerSet("off").size).toBe(0)
    expect(fillerSet(" OFF ").size).toBe(0)
    expect(fillerSet("").size).toBe(0)
  })
})

describe("isFillerOnly", () => {
  test("drops lines made only of fillers", () => {
    for (const line of ["Hmm.", "Uh, um.", "M...", "Mm…", "uh uh uh", "Erm, hmm!"]) expect(isFillerOnly(line, fillers)).toBe(true)
  })
  test("keeps lines with any real word", () => {
    for (const line of ["Um, send it.", "Oh.", "Hmm, yes.", "I think so", "...", ""]) expect(isFillerOnly(line, fillers)).toBe(false)
  })
  test("other languages through the same path", () => {
    const de = fillerSet("äh, ähm, hm")
    expect(isFillerOnly("Ähm... äh.", de)).toBe(true)
    expect(isFillerOnly("Ähm, ja.", de)).toBe(false)
    const ka = fillerSet("ეე, აა")
    expect(isFillerOnly("ეე...", ka)).toBe(true)
    expect(isFillerOnly("ეე კარგი", ka)).toBe(false)
  })
  test("disabled set never drops", () => {
    expect(isFillerOnly("Hmm.", fillerSet("off"))).toBe(false)
  })
})
