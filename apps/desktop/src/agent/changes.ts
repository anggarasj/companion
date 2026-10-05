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

/** Non-overlapping occurrences of `needle` in `hay`. */
const count = (hay: string, needle: string): number => hay.split(needle).length - 1

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

interface Staging {
  c: Record<string, unknown>
  /** The raw change, which is what converted Mermaid is keyed by. */
  item: unknown
  path: string
  ctx: StageContext
  /** Paths already being created in this set, lowercased. */
  creating: Set<string>
}
/** A staged change, or why it was refused. */
type Staged = StagedChange | string

const taken = (s: Staging) => s.ctx.exists(s.path) || s.creating.has(s.path.toLowerCase())

/** Mermaid only ever becomes elements through the converter; elements the model sends itself are not looked at. */
function fromMermaid(s: Staging, def: unknown): BoardInsert | string | undefined {
  if (def === undefined) return undefined
  if (!str(def) || !def.trim()) return 'mermaid must be a diagram definition'
  if (def.length > MAX_MERMAID) return `mermaid longer than ${MAX_MERMAID} characters`
  const done = s.ctx.converted?.get(s.item)
  if (done === undefined) return 'Mermaid cannot be converted here'
  return typeof done === 'string' ? `mermaid: ${done}` : done
}

/** Run a board builder, turning what it throws into a refusal. */
function build(make: () => string): string | { preview: string } {
  try {
    return { preview: make() }
  } catch (e) {
    return (e as Error).message
  }
}

function stageCreateBoard(s: Staging): Staged {
  const insert = fromMermaid(s, s.c.mermaid)
  if (typeof insert === 'string') return insert
  const parts = insert ? { nodes: [], edges: [] } : boardParts(s.c.nodes, s.c.edges)
  if (typeof parts === 'string') return parts
  if (!insert && !parts.nodes.length) return 'create_board needs at least one node, or mermaid'
  if (taken(s)) return 'a file already exists at this path'
  const built = build(() => createBoard(parts.nodes, parts.edges, insert))
  if (typeof built === 'string') return built
  return { type: 'create_board', path: s.path, ...parts, ...(insert ? { insert } : {}), id: nextId(), base: null, preview: built.preview, view: { before: '', after: boardOutline(built.preview) } }
}

function stageEditBoard(s: Staging): Staged {
  const read = s.ctx.reads.get(s.path)
  if (!read) return 'the agent did not read this board before changing it'
  const edit = boardEdit(s.c)
  if (typeof edit === 'string') return edit
  const insert = fromMermaid(s, (s.c.add as Record<string, unknown> | undefined)?.mermaid)
  if (typeof insert === 'string') return insert
  if (insert) edit.insert = insert
  const built = build(() => editBoard(read.body, edit))
  if (typeof built === 'string') return built
  return { type: 'edit_board', path: s.path, edit, id: nextId(), base: read.body, preview: built.preview, view: { before: boardOutline(read.body), after: boardOutline(built.preview) } }
}

function stageCreateNote(s: Staging): Staged {
  const { c } = s
  if (!str(c.title) || !c.title.trim() || !str(c.body)) return 'create_note needs a title and a body'
  if (taken(s)) return 'a note already exists at this path'
  return { type: 'create_note', path: s.path, title: c.title.trim(), body: c.body, id: nextId(), base: null, preview: c.body }
}

/** The edit itself, computed against the body the agent read. */
function noteEdit(c: Record<string, unknown>, path: string, base: string): { change: ProposedChange; preview: string } | string {
  if (c.type === 'replace_text') {
    if (!str(c.oldText) || !c.oldText || !str(c.newText) || c.oldText === c.newText) return 'replace_text needs oldText and a different newText'
    const n = count(base, c.oldText)
    if (n !== 1) return n === 0 ? 'oldText is not in the note' : 'oldText appears more than once'
    return { change: { type: 'replace_text', path, oldText: c.oldText, newText: c.newText }, preview: replaceOnce(base, c.oldText, c.newText) }
  }
  if (c.type === 'append_section') {
    if (!str(c.markdown) || !c.markdown.trim()) return 'append_section needs markdown'
    return { change: { type: 'append_section', path, markdown: c.markdown }, preview: appendTo(base, c.markdown) }
  }
  if (!str(c.body) || !c.body.trim()) return 'replace_body needs a non-empty body'
  return { change: { type: 'replace_body', path, body: c.body }, preview: c.body }
}

function stageNoteEdit(s: Staging): Staged {
  const read = s.ctx.reads.get(s.path)
  if (!read) return 'the agent did not read this note before changing it'
  // A delivered meeting is an archive. The open one is fine: the editor
  // saves an edit of it as a copy, which is the app's own rule.
  if (read.platform && read.platform !== 'manual' && s.path !== s.ctx.currentPath) return 'delivered meetings are archives and are never rewritten'
  const edit = noteEdit(s.c, s.path, read.body)
  if (typeof edit === 'string') return edit
  return { ...edit.change, id: nextId(), base: read.body, preview: edit.preview }
}

const STAGERS = new Map<unknown, (s: Staging) => Staged>([
  ['create_board', stageCreateBoard],
  ['edit_board', stageEditBoard],
  ['create_note', stageCreateNote],
  ['replace_text', stageNoteEdit],
  ['append_section', stageNoteEdit],
  ['replace_body', stageNoteEdit],
])

/** Validate raw proposed changes. Anything malformed is refused, not repaired. */
export function stageChanges(raw: unknown[], ctx: StageContext): { staged: StagedChange[]; rejected: { path: string; reason: string }[] } {
  const staged: StagedChange[] = []
  const rejected: { path: string; reason: string }[] = []
  const creating = new Set<string>()
  for (const item of raw) {
    const c = item as Record<string, unknown>
    const path = str(c.path) ? c.path : ''
    const onBoard = c.type === 'create_board' || c.type === 'edit_board'
    // The open note may be an unsaved draft, addressed by a placeholder path.
    const problem = path && path === ctx.currentPath && !onBoard ? null : pathProblem(c.path, onBoard ? 'board' : 'note')
    const stage = STAGERS.get(c.type)
    const out = problem ?? (stage ? stage({ c, item, path, ctx, creating }) : `unknown change type ${JSON.stringify(c.type)}`)
    if (typeof out === 'string') {
      rejected.push({ path, reason: out })
      continue
    }
    staged.push(out)
    if (out.base === null) creating.add(path.toLowerCase())
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
