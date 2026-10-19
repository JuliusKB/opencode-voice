/**
 * Package identity, bundled release history, and the pure version helpers
 * shared by the server-side update client and the precompiled panel.
 * No filesystem imports here: the panel bundle inlines this module.
 */
import pkg from "../package.json"

type PackageMetadata = {
  version?: unknown
  opencodeVoice?: { releases?: unknown }
}

const metadata = pkg as PackageMetadata

export const VERSION = typeof metadata.version === "string" ? metadata.version : "0.0.0"

/** Stable `x.y.z` only; prereleases and anything else are not comparable. */
export function parts(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** Ascending sort order; non-stable versions compare as equal (callers filter them out). */
export function compareVersions(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i]
  }
  return 0
}

export function newer(candidate: string, installed = VERSION): boolean {
  return parts(candidate) !== null && parts(installed) !== null && compareVersions(candidate, installed) > 0
}

function cleanNotes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim())
    .filter(Boolean)
}

/** Keep only stable versions that carry at least one non-empty, single-line note. */
export function cleanReleases(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([version]) => parts(version) !== null)
      .map(([version, notes]) => [version, cleanNotes(notes)])
      .filter(([, notes]) => notes.length > 0),
  )
}

/** Release notes bundled with this build, newest entries appended in package.json. */
export const RELEASES: Record<string, string[]> = cleanReleases(metadata.opencodeVoice?.releases)
