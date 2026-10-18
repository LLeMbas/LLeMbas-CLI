declare const LEMBAS_VERSION: string | undefined

// Replaced at compile time by scripts/build.ts; read from package.json when run from source.
export const VERSION: string =
  typeof LEMBAS_VERSION === "string" ? LEMBAS_VERSION : (await import("../package.json")).default.version
