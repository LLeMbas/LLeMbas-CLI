/** Time as the eye reads it: 8.4s, 1m 05s, 2h 03m. `whole`: no tenths under a minute (8s) — for a
 *  clock that ticks while you watch. */
export function duration(ms: number, whole = false): string {
  const s = Math.max(0, ms) / 1000
  if (s < 60) return whole ? `${Math.floor(s)}s` : `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}
