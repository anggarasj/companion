// Context budgets and retrieval ordering. The vault never goes to the model
// whole: search returns a handful of paths, reads are cut to a per-note budget,
// and old tool output is elided once the total passes its budget — the vault
// is still there to re-read.
import type { AgentScope, AgentTurn, SearchHit } from './types'

// ponytail: starting values, sized for a 32k-token model; tune per provider
// if a small local model starts losing the thread.
export const MAX_TOTAL_CONTEXT_CHARS = 60_000
export const MAX_NOTE_CONTEXT_CHARS = 12_000
export const MAX_SEARCH_RESULTS = 8
export const MAX_AGENT_STEPS = 8
export const MAX_CALLS_PER_STEP = 4
export const MAX_HISTORY_TURNS = 8
const MAX_REPLY_CHARS = 600
const MAX_SELECTION_CHARS = 4_000

export const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** Is `path` one the scope lets the agent see? */
export function inScope(path: string, scope: AgentScope, currentPath?: string): boolean {
  switch (scope.kind) {
    case 'vault':
      return true
    case 'folder':
      return scope.folder ? path.startsWith(`${scope.folder}/`) : true
    case 'files':
      return scope.paths.includes(path)
    case 'document':
      return path === currentPath
  }
}

/**
 * Order full-text hits. FTS rank dominates; a title match, the same folder as
 * the open note and recency only break near-ties — the newest note is not the
 * most relevant one.
 */
export function rankHits(hits: SearchHit[], query: string, nearFolder?: string): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
  const times = hits.map((h) => Date.parse(h.updatedAt) || 0)
  const newest = Math.max(0, ...times)
  const oldest = Math.min(newest, ...times)
  const span = newest - oldest || 1
  const score = (h: SearchHit, i: number) => {
    const fts = (hits.length - i) / hits.length // 1 … ~0, by FTS rank
    const title = terms.some((w) => h.title.toLowerCase().includes(w)) ? 0.15 : 0
    const near = nearFolder !== undefined && folderOf(h.path) === nearFolder ? 0.1 : 0
    const recent = ((times[i] - oldest) / span) * 0.05
    return fts * 1 + title + near + recent
  }
  const scored = hits.map((h, i) => ({ h, s: score(h, i) }))
  scored.sort((a, b) => b.s - a.s)
  return scored.map((x) => x.h)
}

/** A note body cut to the per-note budget, from `offset`, saying what was left out. */
export function excerpt(body: string, offset = 0, max = MAX_NOTE_CONTEXT_CHARS): { text: string; truncated: boolean; nextOffset?: number } {
  const start = Math.max(0, Math.min(offset, body.length))
  const text = body.slice(start, start + max)
  const end = start + text.length
  return end < body.length ? { text, truncated: true, nextOffset: end } : { text, truncated: false }
}

/** One serialized tool result in the running log. */
export interface LogEntry {
  /** Rendered block, as sent. */
  text: string
  /** Shorter stand-in once the budget runs out. */
  compact: string
}

/**
 * The tool log to send: newest entries in full, older ones swapped for their
 * compact form once the total passes the budget. Order is preserved.
 */
export function budgetLog(entries: LogEntry[], max = MAX_TOTAL_CONTEXT_CHARS): string[] {
  const out = entries.map((e) => e.text)
  let total = out.reduce((n, s) => n + s.length, 0)
  for (let i = 0; i < out.length - 1 && total > max; i++) {
    total -= out[i].length - entries[i].compact.length
    out[i] = entries[i].compact
  }
  return out
}

/** Bounded history: the last few turns, replies shortened. Raw tool output never survives a turn. */
export function compactHistory(turns: AgentTurn[]): AgentTurn[] {
  return turns.slice(-MAX_HISTORY_TURNS).map((t) => ({
    ...t,
    reply: t.reply.length > MAX_REPLY_CHARS ? `${t.reply.slice(0, MAX_REPLY_CHARS)}…` : t.reply,
  }))
}

export const clipSelection = (s: string): string => (s.length > MAX_SELECTION_CHARS ? `${s.slice(0, MAX_SELECTION_CHARS)}…` : s)
