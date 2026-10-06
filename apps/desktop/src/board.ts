// The pure side of a whiteboard file, kept apart from Whiteboard.tsx because
// Excalidraw itself cannot load outside a browser.
import type { serializeAsJSON } from '@excalidraw/excalidraw'

type Scene = Parameters<typeof serializeAsJSON>
export type Board = { elements: Scene[0]; appState: Partial<Scene[1]>; files: Scene[2] }

export const isBoard = (rel: string): boolean => /\.excalidraw$/i.test(rel)

/** What a brand-new board file contains: Excalidraw's own empty-scene format. */
export const EMPTY_BOARD = JSON.stringify(
  { type: 'excalidraw', version: 2, source: 'meet-companion', elements: [], appState: {}, files: {} },
  null,
  2,
)

/** A board file's scene; an empty file is an empty board, anything else that is not JSON throws. */
export function parseBoard(text: string): Board {
  if (!text.trim()) return { elements: [], appState: {}, files: {} }
  const data = JSON.parse(text) as Partial<Board>
  return { elements: data.elements ?? [], appState: data.appState ?? {}, files: data.files ?? {} }
}

/**
 * Where a new board goes: `folder/<label> <local time>.excalidraw`, numbered
 * when that name is taken — a write there would replace the existing board.
 */
export function newBoardPath(folder: string, label: string, now: Date, taken: readonly string[]): string {
  // sv-SE formats as "2026-10-05 12:46:34" in local time; ':' is not allowed in macOS/Windows file names.
  const base = (folder ? folder + '/' : '') + `${label} ${now.toLocaleString('sv-SE').replace(/:/g, '.')}`
  const used = new Set(taken)
  let rel = `${base}.excalidraw`
  for (let n = 2; used.has(rel); n++) rel = `${base} ${n}.excalidraw`
  return rel
}

// ---- What the AI agent reads and writes ----
//
// The agent never sees or writes Excalidraw's element format. It reads an
// outline (one line per element, with ids), and writes nodes and edges that
// are expanded here into complete elements: a shape with its label bound to
// it, arrows bound at both ends. Excalidraw fills anything else on load.

type El = { id: string; type: string; isDeleted?: boolean; [key: string]: unknown }

export interface BoardNode {
  /** The model's own handle for the node, used by edges in the same request. */
  id: string
  label: string
  shape?: 'rectangle' | 'ellipse' | 'diamond'
  x?: number
  y?: number
}
export interface BoardEdge {
  /** A node id from the same request, or the id of a shape already on the board. */
  from: string
  to: string
  label?: string
}
/** Finished elements from the Mermaid converter — never from the model itself. */
export interface BoardInsert {
  elements: unknown[]
  files: Record<string, unknown>
}
export interface BoardEdit {
  add?: { nodes?: BoardNode[]; edges?: BoardEdge[] }
  relabel?: { id: string; text: string }[]
  remove?: string[]
  insert?: BoardInsert
}

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])
const NODE_W = 200
const GAP = 80
const FONT = 20
const LINE = 1.25
const CHARS_PER_LINE = 16

const live = (els: El[]) => els.filter((e) => !e.isDeleted)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const elementsOf = (text: string): El[] => (parseBoard(text).elements as unknown as El[]) ?? []
const quote = (s: string) => JSON.stringify(s.length > 120 ? `${s.slice(0, 120)}…` : s)

/**
 * One line per element, ids included, so the agent can refer to them. Bound
 * labels and arrow geometry are left out on purpose: Excalidraw recomputes
 * them, and the outline is also what decides whether a board changed.
 */
export function boardOutline(text: string): string {
  const els = live(elementsOf(text))
  const labelOf = new Map<string, string>()
  for (const e of els) if (e.type === 'text' && typeof e.containerId === 'string') labelOf.set(e.containerId, String(e.text ?? ''))
  const lines = els.flatMap((e) => {
    if (e.type === 'text') return typeof e.containerId === 'string' ? [] : [`#${e.id} text ${quote(String(e.text ?? ''))}`]
    const label = labelOf.has(e.id) ? ` ${quote(labelOf.get(e.id)!)}` : ''
    if (e.type === 'arrow' || e.type === 'line') {
      const end = (b: unknown) => (b && typeof b === 'object' && 'elementId' in b ? `#${String((b as { elementId: unknown }).elementId)}` : '·')
      return [`#${e.id} ${e.type} ${end(e.startBinding)} → ${end(e.endBinding)}${label}`]
    }
    const box = `at ${Math.round(num(e.x))},${Math.round(num(e.y))} size ${Math.round(num(e.width))}x${Math.round(num(e.height))}`
    return [`#${e.id} ${e.type}${label} ${box}`]
  })
  return lines.length ? lines.join('\n') : '(empty board)'
}

/** Are two boards the same as far as anyone looking at them could tell? */
export const sameBoard = (a: string, b: string): boolean => boardOutline(a) === boardOutline(b)

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20)
const seed = () => Math.floor(Math.random() * 2 ** 31)
const common = () => ({
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: null,
  seed: seed(),
  version: 1,
  versionNonce: seed(),
  isDeleted: false,
  updated: Date.now(),
  link: null,
  locked: false,
})

function wrap(label: string): string[] {
  const lines: string[] = []
  let line = ''
  // Words and line breaks in one pass; a break always starts a new line.
  for (const token of label.split(/(\n)|[^\S\n]+/)) {
    if (token === '\n') {
      lines.push(line)
      line = ''
    } else if (!token) continue
    else if (line && (line + ' ' + token).length > CHARS_PER_LINE) {
      lines.push(line)
      line = token
    } else line = line ? `${line} ${token}` : token
  }
  lines.push(line)
  return lines
}

/** A text element bound into `container`, centred in it. */
function boundText(container: El, label: string, at?: { x: number; y: number }): El {
  const lines = wrap(label)
  const width = Math.max(...lines.map((l) => l.length), 1) * FONT * 0.55
  const height = lines.length * FONT * LINE
  const cx = at?.x ?? num(container.x) + num(container.width) / 2
  const cy = at?.y ?? num(container.y) + num(container.height) / 2
  const text = lines.join('\n')
  return {
    ...common(),
    id: newId(),
    type: 'text',
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    text,
    originalText: label,
    fontSize: FONT,
    fontFamily: 5,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: container.id,
    lineHeight: LINE,
    autoResize: true,
    boundElements: [],
    roundness: null,
  }
}

/** Where a line from `c` towards `toward` leaves the box of `e`. */
function border(e: El, toward: { x: number; y: number }, gap: number) {
  const hw = num(e.width) / 2
  const hh = num(e.height) / 2
  const c = { x: num(e.x) + hw, y: num(e.y) + hh }
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (!dx && !dy) return c
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity)
  const len = Math.hypot(dx, dy)
  return { x: c.x + dx * t + (dx / len) * gap, y: c.y + dy * t + (dy / len) * gap }
}
const centre = (e: El) => ({ x: num(e.x) + num(e.width) / 2, y: num(e.y) + num(e.height) / 2 })

const bind = (e: El, ref: { type: string; id: string }): El => ({
  ...e,
  boundElements: [...((e.boundElements as unknown[]) ?? []), ref],
  version: num(e.version) + 1,
  versionNonce: seed(),
  updated: Date.now(),
})

/** Add nodes and edges to `els`; new nodes go in a grid below what is there. */
function addTo(els: El[], add: NonNullable<BoardEdit['add']>): El[] {
  const nodes = add.nodes ?? []
  const edges = add.edges ?? []
  const out = [...els]
  const shown = live(els)
  const top = shown.length ? Math.max(...shown.map((e) => num(e.y) + num(e.height))) + 120 : 0
  const left = shown.length ? Math.min(...shown.map((e) => num(e.x))) : 0
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
  const handle = new Map<string, string>() // model id → element id
  for (const [i, n] of nodes.entries()) {
    const lines = wrap(n.label).length
    const height = Math.max(90, lines * FONT * LINE + 40)
    const shape: El = {
      ...common(),
      id: newId(),
      type: n.shape && SHAPES.has(n.shape) ? n.shape : 'rectangle',
      x: n.x ?? left + (i % cols) * (NODE_W + GAP),
      y: n.y ?? top + Math.floor(i / cols) * (90 + GAP + 40),
      width: NODE_W,
      height,
      roundness: { type: 3 },
      boundElements: [],
    }
    const label = boundText(shape, n.label)
    out.push({ ...shape, boundElements: [{ type: 'text', id: label.id }] }, label)
    handle.set(n.id, shape.id)
  }
  for (const edge of edges) {
    const resolve = (ref: string) => {
      const id = handle.get(ref) ?? ref
      const i = out.findIndex((e) => e.id === id && !e.isDeleted && e.type !== 'text' && e.type !== 'arrow' && e.type !== 'line')
      if (i === -1) throw new Error(`no shape "${ref}" to connect`)
      return i
    }
    const a = resolve(edge.from)
    const b = resolve(edge.to)
    const start = border(out[a], centre(out[b]), 8)
    const end = border(out[b], centre(out[a]), 8)
    const arrow: El = {
      ...common(),
      id: newId(),
      type: 'arrow',
      x: start.x,
      y: start.y,
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
      points: [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ],
      startBinding: { elementId: out[a].id, focus: 0, gap: 8 },
      endBinding: { elementId: out[b].id, focus: 0, gap: 8 },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
      lastCommittedPoint: null,
      roundness: { type: 2 },
      boundElements: [],
    }
    out[a] = bind(out[a], { type: 'arrow', id: arrow.id })
    out[b] = bind(out[b], { type: 'arrow', id: arrow.id })
    if (edge.label?.trim()) {
      const label = boundText(arrow, edge.label.trim(), { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 })
      out.push({ ...arrow, boundElements: [{ type: 'text', id: label.id }] }, label)
    } else out.push(arrow)
  }
  return out
}

function serialize(text: string, elements: El[], extraFiles: Record<string, unknown> = {}): string {
  const { appState, files } = parseBoard(text)
  return JSON.stringify(
    { type: 'excalidraw', version: 2, source: 'meet-companion', elements, appState, files: { ...files, ...extraFiles } },
    null,
    2,
  )
}

/** Converted elements placed below what the board already shows, keeping their own layout. */
function insertInto(els: El[], insert: BoardInsert): El[] {
  const added = insert.elements as El[]
  const shown = live(els)
  if (!shown.length || !added.length) return [...els, ...added]
  const top = Math.max(...shown.map((e) => num(e.y) + num(e.height))) + 120
  const left = Math.min(...shown.map((e) => num(e.x)))
  const dx = left - Math.min(...added.map((e) => num(e.x)))
  const dy = top - Math.min(...added.map((e) => num(e.y)))
  // Arrow and line points are relative to x/y, so moving x/y moves the whole element.
  return [...els, ...added.map((e) => ({ ...e, x: num(e.x) + dx, y: num(e.y) + dy }))]
}

/** A new board file from nodes and edges, or from converted Mermaid. */
export function createBoard(nodes: BoardNode[], edges: BoardEdge[], insert?: BoardInsert): string {
  return insert ? serialize('', insertInto([], insert), insert.files) : serialize('', addTo([], { nodes, edges }))
}

/**
 * Apply an edit to a board file's text. Throws, naming the id, when the edit
 * refers to something not on the board — which is also how a change made
 * against an older version of the board is caught.
 */
export function editBoard(text: string, edit: BoardEdit): string {
  let els = elementsOf(text)
  /** Where each element still on the board sits, by id. */
  const liveIndex = () => {
    const at = new Map<string, number>()
    els.forEach((e, i) => !e.isDeleted && at.set(e.id, i))
    return at
  }
  const missing = (id: string) => new Error(`no element "${id}" on the board`)
  const bump = (e: El, patch: Record<string, unknown>): El => ({ ...e, ...patch, version: num(e.version) + 1, versionNonce: seed(), updated: Date.now() })

  const remove = edit.remove ?? []
  if (remove.length) {
    // Every id is checked against the board as it was, before anything goes:
    // removing a shape takes its arrows too, and the same edit naming one of
    // those arrows is clearing the board, not a stale reference.
    const at = liveIndex()
    for (const id of remove) if (!at.has(id)) throw missing(id)
    const gone = new Set(remove)
    const boundTo = (b: unknown) => (b && typeof b === 'object' ? (b as { elementId?: unknown }).elementId : undefined)
    for (const e of els) {
      // Its label and the arrows tied to it go with it; a dangling arrow is noise.
      if (gone.has(String(boundTo(e.startBinding))) || gone.has(String(boundTo(e.endBinding)))) gone.add(e.id)
    }
    els = els.map((e) => (!e.isDeleted && (gone.has(e.id) || (typeof e.containerId === 'string' && gone.has(e.containerId))) ? bump(e, { isDeleted: true }) : e))
  }

  const at = liveIndex()
  const labelAt = new Map<string, number>()
  els.forEach((e, i) => !e.isDeleted && typeof e.containerId === 'string' && labelAt.set(e.containerId, i))
  for (const { id, text: label } of edit.relabel ?? []) {
    const i = at.get(id)
    if (i === undefined) throw missing(id)
    const target = els[i]
    const boundIdx = target.type === 'text' ? i : (labelAt.get(id) ?? -1)
    if (boundIdx !== -1) {
      const t = els[boundIdx]
      const lines = wrap(label)
      els[boundIdx] = bump(t, { text: typeof t.containerId === 'string' ? lines.join('\n') : label, originalText: label })
    } else {
      const added = boundText(target, label)
      els[i] = bind(target, { type: 'text', id: added.id })
      labelAt.set(id, els.length)
      els.push(added)
    }
  }

  if (edit.add) els = addTo(els, edit.add)
  if (edit.insert) els = insertInto(els, edit.insert)
  return serialize(text, els, edit.insert?.files)
}
