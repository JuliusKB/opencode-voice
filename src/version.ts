import pkg from "../package.json"

type PackageMetadata = {
  version?: unknown
  opencodeVoice?: { releases?: unknown }
}

const metadata = pkg as PackageMetadata

export const VERSION = typeof metadata.version === "string" ? metadata.version : "0.0.0"

export const RELEASES: Record<string, string[]> = metadata.opencodeVoice?.releases
  && typeof metadata.opencodeVoice.releases === "object"
  ? Object.fromEntries(
      Object.entries(metadata.opencodeVoice.releases as Record<string, unknown>)
        .filter(([, notes]) => Array.isArray(notes))
        .map(([version, notes]) => [version, (notes as unknown[]).filter((note): note is string => typeof note === "string")]),
    )
  : {}
