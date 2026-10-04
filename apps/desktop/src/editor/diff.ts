// Line diff for "Show changes" on an AI edit: what the document was, what the
// AI made it. Longest-common-subsequence over lines, which is exact and plenty
// for a note.

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

/** ponytail: O(n·m) table; past this many cells it reports a full replace. */
const MAX_CELLS = 2_000_000

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))]
  }
  // lcs[i][j] = length of the LCS of a[i:] and b[j:]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: 'del', text: a[i++] })
    else out.push({ kind: 'add', text: b[j++] })
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}
