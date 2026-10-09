// Release versions: vX.Y.Z (stable) and vX.Y.Z-beta.N (beta). Compared as SemVer — git's own
// version sort puts v1.1.0-beta.1 above v1.1.0, which would hand a stable install a pre-release.

export interface Version {
  major: number
  minor: number
  patch: number
  /** The N of -beta.N; undefined for a stable release. */
  beta?: number
}

const TAG = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/

/** A release tag or version; undefined for anything else (a source build's 0.9.2+g1234abc, an rc). */
export function parseVersion(s: string): Version | undefined {
  const m = TAG.exec(s.trim())
  if (!m) return undefined
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, beta: m[4] === undefined ? undefined : +m[4] }
}

/** Negative when a is older than b. A beta is older than its own release. */
export function compareVersions(a: Version, b: Version): number {
  const beta = (v: Version) => v.beta ?? Number.MAX_SAFE_INTEGER
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || beta(a) - beta(b)
}

export const isStable = (v: Version) => v.beta === undefined
export const versionText = (v: Version) => `${v.major}.${v.minor}.${v.patch}${v.beta === undefined ? "" : `-beta.${v.beta}`}`

/** The newest tag the channel takes: stable, or (beta) the newest of stable and beta. */
export function newestFor<T extends { tag: string }>(releases: T[], channel: "stable" | "beta"): (T & { version: Version }) | undefined {
  let best: (T & { version: Version }) | undefined
  for (const r of releases) {
    const v = parseVersion(r.tag)
    if (!v || (channel === "stable" && !isStable(v))) continue
    if (!best || compareVersions(v, best.version) > 0) best = { ...r, version: v }
  }
  return best
}
