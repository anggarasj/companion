// Staged writes. The model never touches a file: it proposes changes, this
// module validates them against what the agent actually read, and only an
// explicit Apply writes — after checking the note still says what the change
// was computed against. Undo is checked the same way, so neither ever lands on
// top of an edit the user made in the meantime.
import { boardOutline, createBoard, editBoard, isBoard, sameBoard, type BoardEdge, type BoardEdit, type BoardInsert, type BoardNode } from '../board'
import type { AppliedChange, ChangeTarget, ProposedChange, StagedChange } from './types'

let seq = 0
const nextId = (): string => `c${Date.now().toString(36)}${(++seq).toString(36)}`

const KIND = {
  note: { re: /\.md$/i, problem: 'not a Markdown note' },
  board: { re: /\.excalidraw$/i, problem: 'not an Excalidraw board' },
  read: { re: /\.(md|excalidraw|pdf)$/i, problem: 'not a note, board or PDF' },
}

/** Why the agent may not use `path` (as a note, a board, or anything it can read), or null when it may. */
export function pathProblem(path: unknown, kind: keyof typeof KIND = 'note'): string | null {
  if (typeof path !== 'string' || !path.trim()) return 'missing path'
  if (path.length > 300) return 'path too long'
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\\\u0000-\u001f]/.test(path)) return 'invalid characters in path'
  if (/^([/~]|[A-Za-z]:)/.test(path)) return 'absolute path'
  const parts = path.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'path traversal'
  if (parts.some((p) => p.startsWith('.'))) return 'hidden folder'
  if (!KIND[kind].re.test(path)) return KIND[kind].problem
  return null
}

const count = (hay: string, needle: string): number => {
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

/** Replace the one occurrence — by slicing, so `$&` in the text stays text. */
const replaceOnce = (body: string, oldText: string, newText: string): string => {
  const i = body.indexOf(oldText)
  return body.slice(0, i) + newText + body.slice(i + oldText.length)
}

const appendTo = (body: string, markdown: string): string => (body.trim() ? `${body.trimEnd()}\n\n${markdown.trim()}` : markdown.trim())

export interface StageContext {
  /** Notes read during the run: the only notes the agent may edit. */
  reads: Map<string, { title: string; body: string; platform?: string }>
  /** Is there a note at this path already (case-insensitively)? */
  exists(path: string): boolean
  /** The open note, which is edited through the editor. */
  currentPath?: string
  /** Mermaid in a change, already converted (or why it would not convert), keyed by the raw change. */
  converted?: Map<unknown, BoardInsert | string>
}

const str = (v: unknown): v is string => typeof v === 'string'

const MAX_MERMAID = 20_000
const MAX_NODES = 100
const MAX_EDGES = 200
const SHAPES = ['rectangle', 'ellipse', 'diamond']

/** Nodes and edges as the model sent them, or why they will not do. */
function boardParts(nodes: unknown, edges: unknown): { nodes: BoardNode[]; edges: BoardEdge[] } | string {
  const ns = nodes ?? []
  const es = edges ?? []
  if (!Array.isArray(ns) || !Array.isArray(es)) return 'nodes and edges must be lists'
  if (ns.length > MAX_NODES || es.length > MAX_EDGES) return `at most ${MAX_NODES} nodes and ${MAX_EDGES} edges`
  const okNode = (n: Record<string, unknown>) =>
    str(n.id) && !!n.id && str(n.label) && (n.shape === undefined || SHAPES.includes(n.shape as string)) &&
    [n.x, n.y].every((v) => v === undefined || (typeof v === 'number' && Number.isFinite(v)))
  if (!ns.every((n) => n && typeof n === 'object' && okNode(n as Record<string, unknown>))) return 'each node needs an id and a label'
  if (!es.every((e) => e && typeof e === 'object' && str(e.from) && str(e.to) && (e.label === undefined || str(e.label)))) return 'each edge needs from and to'
  return { nodes: ns as BoardNode[], edges: es as BoardEdge[] }
}

/** A board edit as the model sent it, or why it will not do. */
function boardEdit(c: Record<string, unknown>): BoardEdit | string {
  const add = c.add as Record<string, unknown> | undefined
  const parts = add === undefined ? { nodes: [], edges: [] } : typeof add === 'object' && add ? boardParts(add.nodes, add.edges) : 'add must be an object'
  if (typeof parts === 'string') return parts
  const mermaid = add?.mermaid
  if (mermaid !== undefined && !(str(mermaid) && mermaid.trim())) return 'add.mermaid must be a diagram definition'
  const relabel = c.relabel ?? []
  const remove = c.remove ?? []
  if (!Array.isArray(relabel) || !relabel.every((r) => r && typeof r === 'object' && str(r.id) && str(r.text))) return 'relabel needs {id, text} items'
  if (!Array.isArray(remove) || !remove.every(str)) return 'remove must be a list of ids'
  if (!parts.nodes.length && !parts.edges.length && !mermaid && !relabel.length && !remove.length) return 'edit_board changes nothing'
  return { add: parts, relabel: relabel as BoardEdit['relabel'], remove: remove as string[] }
}

/** Validate raw proposed changes. Anything malformed is refused, not repaired. */
export function stageChanges(raw: unknown[], ctx: StageContext): { staged: StagedChange[]; rejected: { path: string; reason: string }[] } {
  const staged: StagedChange[] = []
  const rejected: { path: string; reason: string }[] = []
  const creating = new Set<string>()
  for (const item of raw) {
    const c = item as Record<string, unknown>
    const path = str(c.path) ? c.path : ''
    const refuse = (reason: string) => rejected.push({ path, reason })
    const onBoard = c.type === 'create_board' || c.type === 'edit_board'
    // The open note may be an unsaved draft, addressed by a placeholder path.
    const problem = path && path === ctx.currentPath && !onBoard ? null : pathProblem(c.path, onBoard ? 'board' : 'note')
    if (problem) {
      refuse(problem)
      continue
    }
    // Mermaid only ever becomes elements through the converter; elements
    // the model sends itself are not looked at.
    const fromMermaid = (def: unknown): BoardInsert | string | undefined => {
      if (def === undefined) return undefined
      if (!str(def) || !def.trim()) return 'mermaid must be a diagram definition'
      if (def.length > MAX_MERMAID) return `mermaid longer than ${MAX_MERMAID} characters`
      const done = ctx.converted?.get(item)
      if (done === undefined) return 'Mermaid cannot be converted here'
      return typeof done === 'string' ? `mermaid: ${done}` : done
    }
    if (c.type === 'create_board') {
      const insert = fromMermaid(c.mermaid)
      if (typeof insert === 'string') {
        refuse(insert)
        continue
      }
      const parts = insert ? { nodes: [], edges: [] } : boardParts(c.nodes, c.edges)
      if (typeof parts === 'string') {
        refuse(parts)
        continue
      }
      if (!insert && !parts.nodes.length) {
        refuse('create_board needs at least one node, or mermaid')
        continue
      }
      if (ctx.exists(path) || creating.has(path.toLowerCase())) {
        refuse('a file already exists at this path')
        continue
      }
      let preview: string
      try {
        preview = createBoard(parts.nodes, parts.edges, insert)
      } catch (e) {
        refuse((e as Error).message)
        continue
      }
      creating.add(path.toLowerCase())
      staged.push({ type: 'create_board', path, ...parts, ...(insert ? { insert } : {}), id: nextId(), base: null, preview, view: { before: '', after: boardOutline(preview) } })
      continue
    }
    if (c.type === 'edit_board') {
      const read = ctx.reads.get(path)
      if (!read) {
        refuse('the agent did not read this board before changing it')
        continue
      }
      const edit = boardEdit(c)
      if (typeof edit === 'string') {
        refuse(edit)
        continue
      }
      const insert = fromMermaid((c.add as Record<string, unknown> | undefined)?.mermaid)
      if (typeof insert === 'string') {
        refuse(insert)
        continue
      }
      if (insert) edit.insert = insert
      let preview: string
      try {
        preview = editBoard(read.body, edit)
      } catch (e) {
        refuse((e as Error).message)
        continue
      }
      staged.push({ type: 'edit_board', path, edit, id: nextId(), base: read.body, preview, view: { before: boardOutline(read.body), after: boardOutline(preview) } })
      continue
    }
    if (c.type === 'create_note') {
      if (!str(c.title) || !c.title.trim() || !str(c.body)) {
        refuse('create_note needs a title and a body')
        continue
      }
      if (ctx.exists(path) || creating.has(path.toLowerCase())) {
        refuse('a note already exists at this path')
        continue
      }
      creating.add(path.toLowerCase())
      staged.push({ type: 'create_note', path, title: c.title.trim(), body: c.body, id: nextId(), base: null, preview: c.body })
      continue
    }
    if (!['replace_text', 'append_section', 'replace_body'].includes(c.type as string)) {
      refuse(`unknown change type ${JSON.stringify(c.type)}`)
      continue
    }
    const read = ctx.reads.get(path)
    if (!read) {
      refuse('the agent did not read this note before changing it')
      continue
    }
    // A delivered meeting is an archive. The open one is fine: the editor
    // saves an edit of it as a copy, which is the app's own rule.
    if (read.platform && read.platform !== 'manual' && path !== ctx.currentPath) {
      refuse('delivered meetings are archives and are never rewritten')
      continue
    }
    const base = read.body
    let change: ProposedChange
    let preview: string
    if (c.type === 'replace_text') {
      if (!str(c.oldText) || !c.oldText || !str(c.newText) || c.oldText === c.newText) {
        refuse('replace_text needs oldText and a different newText')
        continue
      }
      const n = count(base, c.oldText)
      if (n !== 1) {
        refuse(n === 0 ? 'oldText is not in the note' : 'oldText appears more than once')
        continue
      }
      change = { type: 'replace_text', path, oldText: c.oldText, newText: c.newText }
      preview = replaceOnce(base, c.oldText, c.newText)
    } else if (c.type === 'append_section') {
      if (!str(c.markdown) || !c.markdown.trim()) {
        refuse('append_section needs markdown')
        continue
      }
      change = { type: 'append_section', path, markdown: c.markdown }
      preview = appendTo(base, c.markdown)
    } else {
      if (!str(c.body) || !c.body.trim()) {
        refuse('replace_body needs a non-empty body')
        continue
      }
      change = { type: 'replace_body', path, body: c.body }
      preview = c.body
    }
    staged.push({ ...change, id: nextId(), base, preview })
  }
  return { staged, rejected }
}

export type ApplyResult = { ok: true; applied: AppliedChange } | { ok: false; reason: 'stale' | 'missing' | 'exists' }

/** Apply one staged change, if the note still holds what it was computed against. */
export async function applyChange(c: StagedChange, target: ChangeTarget): Promise<ApplyResult> {
  const current = await target.readBody(c.path)
  if (c.type === 'create_note' || c.type === 'create_board') {
    if (current !== null) return { ok: false, reason: 'exists' }
    const title = c.type === 'create_note' ? c.title : ''
    return { ok: true, applied: { path: c.path, before: null, after: await target.create(c.path, title, c.preview) } }
  }
  if (current === null) return { ok: false, reason: 'missing' }
  let next: string
  if (c.type === 'edit_board') {
    // Every id it names must still be on the board, the way a text edit needs its anchor.
    try {
      next = editBoard(current, c.edit)
    } catch {
      return { ok: false, reason: 'stale' }
    }
  } else if (c.type === 'replace_text') {
    // The anchor, not the whole body: an edit elsewhere in the note does not
    // invalidate this one, and a second change to the same note still applies.
    if (count(current, c.oldText) !== 1) return { ok: false, reason: 'stale' }
    next = replaceOnce(current, c.oldText, c.newText)
  } else if (c.type === 'append_section') {
    next = appendTo(current, c.markdown) // additive: nothing the user wrote is replaced
  } else {
    if (current !== c.base) return { ok: false, reason: 'stale' }
    next = c.body
  }
  return { ok: true, applied: { path: c.path, before: current, after: await target.writeBody(c.path, next) } }
}

/**
 * Undo applied changes, all or nothing: every touched note must still be
 * exactly as the changes left it, or nothing is restored.
 */
export async function undoApplied(applied: AppliedChange[], target: ChangeTarget): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  // Several changes to one note: restore its first `before`, expect its last `after`.
  const byPath = new Map<string, AppliedChange>()
  for (const a of applied) {
    const seen = byPath.get(a.path)
    byPath.set(a.path, seen ? { path: a.path, before: seen.before, after: a.after } : a)
  }
  const conflicts: string[] = []
  for (const a of byPath.values()) {
    const now = await target.readBody(a.path)
    // A board open in the editor comes back re-serialized by Excalidraw; what counts is what it shows.
    const same = now !== null && (isBoard(a.path) ? sameBoard(now, a.after) : now === a.after)
    if (!same) conflicts.push(a.path)
  }
  if (conflicts.length) return { ok: false, conflicts }
  for (const a of byPath.values()) {
    if (a.before === null) await target.remove(a.path)
    else await target.writeBody(a.path, a.before)
  }
  return { ok: true }
}
