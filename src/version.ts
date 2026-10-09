declare const LEMBAS_VERSION: string | undefined
declare const LEMBAS_DEFAULT_INSTANCE: string | undefined

// Replaced at compile time by scripts/build.ts; read from package.json when run from source.
export const VERSION: string =
  typeof LEMBAS_VERSION === "string" ? LEMBAS_VERSION : (await import("../package.json")).default.version

/** Reserved for a build that names an instance for its first-run screen. Always "" in the
 *  builds this repository makes, and nothing reads it yet. */
export const DEFAULT_INSTANCE: string = typeof LEMBAS_DEFAULT_INSTANCE === "string" ? LEMBAS_DEFAULT_INSTANCE : ""
