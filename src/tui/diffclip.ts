// Shortening a unified diff for the transcript (ctrl+o shows it whole). The result must still be a
// diff the renderer can parse: a hunk cut part-way gets a header whose counts match the lines
// kept, later hunks are dropped, and how much was left out is said outside the diff — a note
// inside it ("@@ … 3 more lines @@") is a line no hunk may contain, and the parser refused the
// whole diff (every edit longer than the limit showed "Error parsing diff").

/** Keep at most `lines` lines of hunk bodies. `hidden` is how many diff lines were left out. */
export function clipDiff(diff: string, lines: number): { diff: string; hidden: number } {
  const all = diff.replace(/\n$/, "").split("\n")
  const first = all.findIndex((l) => l.startsWith("@@"))
  if (first === -1) return { diff, hidden: 0 }
  const body = all.length - first
  if (body <= lines + 1) return { diff, hidden: 0 }
  const out = all.slice(0, first)
  let budget = lines
  let i = first
  while (i < all.length && budget > 0) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(all[i]!)
    if (!m) break
    let j = i + 1
    while (j < all.length && !all[j]!.startsWith("@@")) j++
    const hunk = all.slice(i + 1, j)
    const kept: string[] = []
    for (const l of hunk) {
      if (budget <= 0) break
      kept.push(l)
      if (!l.startsWith("\\")) budget--
    }
    // A "\ No newline at end of file" belongs to the line before it; keep it with that line.
    if (kept.length < hunk.length && hunk[kept.length]?.startsWith("\\")) kept.push(hunk[kept.length]!)
    const oldN = kept.filter((l) => l[0] === " " || l[0] === "-" || l === "").length
    const newN = kept.filter((l) => l[0] === " " || l[0] === "+" || l === "").length
    out.push(`@@ -${m[1]},${oldN} +${m[2]},${newN} @@${m[3]}`, ...kept)
    i = kept.length === hunk.length ? j : all.length
  }
  const shown = out.length - first
  return { diff: out.join("\n") + "\n", hidden: Math.max(0, body - shown) }
}
