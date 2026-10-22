/**
 * Filler-only lines. Whisper occasionally turns a breath or a false start
 * into a line of its own ("Hmm.", "Uh, um.", "M..."). Such a line is dropped
 * when every word in it is on the user's filler list; a line with any other
 * word is never touched. The list is a setting because fillers differ by
 * language and the plugin ships multilingual models.
 */

/** The special value that disables the filter (the menu restores the default on an empty field). */
export const FILLER_OFF = "off"

/** Lowercase, strip Unicode punctuation (incl. … and ...), split on whitespace. Applied to the list and to the line alike. */
export function fillerTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\p{P}+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
}

/** The comma-separated setting as a set of normalized tokens; empty when disabled. */
export function fillerSet(setting: string): Set<string> {
  if (setting.trim().toLowerCase() === FILLER_OFF) return new Set()
  return new Set(setting.split(",").flatMap(fillerTokens))
}

/** True when the line has at least one word and every word is a filler. */
export function isFillerOnly(line: string, fillers: Set<string>): boolean {
  if (fillers.size === 0) return false
  const tokens = fillerTokens(line)
  return tokens.length > 0 && tokens.every((t) => fillers.has(t))
}
