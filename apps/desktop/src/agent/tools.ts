// The agent's read tools, and the adapter that backs them with the real vault.
//
// Every tool checks the scope the user chose and the path it was given before
// touching anything; a refusal is a tool result the model can read, not an
// exception. Nothing in here writes — writing is changes.ts, behind Apply.
import { uuidV7, type Vault, type VaultIndexRow, type VaultNote } from '@meetcc/vault'
import { boardOutline, isBoard, type BoardInsert } from '../board'
import { excerpt, folderOf, inScope, MAX_SEARCH_RESULTS, rankHits } from './context'
import { pathProblem } from './changes'
import { TOOL_NAMES, type AgentScope, type AgentToolCall, type ChangeTarget, type CurrentDoc, type SearchHit, type ToolName, type Workspace } from './types'

/** Placeholder path for an open note that has no file yet. */
export const UNSAVED_DOC = '@current'

const LIST_LIMIT = 60

export interface ToolState {
  /** Everything read, in full: the base staged changes are checked against. */
  reads: Map<string, { title: string; body: string; platform?: string }>
}

export interface ToolOutcome {
  /** The data handed back to the model. */
  result: Record<string, unknown>
  /** One line for the user: what the agent just did. */
  activity: { tool: ToolName | 'unknown'; detail: string }
}

/** Identity of a call, for refusing the same call twice in one run. */
export function callKey(call: AgentToolCall): string {
  const keys = Object.keys(call.args)
  keys.sort()
  return `${call.tool}:${JSON.stringify(keys.map((k) => [k, call.args[k]]))}`
}

const folderProblem = (folder: string): string | null =>
  folder === '' ? null : pathProblem(`${folder.replace(/\/+$/, '')}/x.md`)

/** A pattern matching a path that contains any word of `query` longer than one character. */
export function nameMatcher(query: string): RegExp | null {
  const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
  return terms.length ? new RegExp(terms.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null
}

/** What every tool handler works from. */
interface ToolCtx {
  ws: Workspace
  a: Record<string, unknown>
  state: ToolState
  visible: (path: string) => boolean
}
type Handler = (c: ToolCtx) => Promise<ToolOutcome> | ToolOutcome

const trimFolder = (v: unknown) => (typeof v === 'string' ? v.replace(/^\/+|\/+$/g, '') : '')
const part = (text: string, offset: unknown) => {
  const p = excerpt(text, Number(offset) || 0)
  return { content: p.text, ...(p.truncated ? { truncated: true, nextOffset: p.nextOffset } : {}) }
}

const searchVault: Handler = ({ ws, a, visible }) => {
  const tool = 'search_vault'
  const query = typeof a.query === 'string' ? a.query.trim() : ''
  if (!query) return { result: { error: 'query is required' }, activity: { tool, detail: '' } }
  const folder = trimFolder(a.folder)
  const problem = folderProblem(folder)
  if (problem) return { result: { error: `folder: ${problem}` }, activity: { tool, detail: query } }
  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(a.limit) || MAX_SEARCH_RESULTS))
  const fits = (p: string) => visible(p) && (!folder || p.startsWith(`${folder}/`))
  const hits = ws.search(query).filter((h) => !pathProblem(h.path) && fits(h.path))
  // ponytail: boards and PDFs are not in the full-text index, so they match
  // on their file name only; index their text if that proves too little.
  const named: SearchHit[] = []
  const matches = nameMatcher(query)
  for (const p of matches ? ws.files() : []) if (fits(p) && matches?.test(p)) named.push({ path: p, title: p.split('/').pop() ?? p, updatedAt: '' })
  const results = [...rankHits(hits, query, ws.current ? folderOf(ws.current.path) : undefined), ...named].slice(0, limit)
  return { result: { query, results, ...(results.length ? {} : { note: 'no matching notes in scope' }) }, activity: { tool, detail: query } }
}

const listFolder: Handler = ({ ws, a, visible }) => {
  const tool = 'list_folder'
  const folder = trimFolder(a.path)
  const problem = folderProblem(folder)
  if (problem) return { result: { error: `path: ${problem}` }, activity: { tool, detail: folder } }
  const prefix = folder ? `${folder}/` : ''
  const notes: string[] = []
  const files: string[] = []
  const subfolders = new Set<string>()
  const place = (p: string, here: string[]) => {
    if (!visible(p) || !p.startsWith(prefix)) return
    const rest = p.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash === -1) here.push(p)
    else subfolders.add(rest.slice(0, slash))
  }
  for (const p of ws.paths()) place(p, notes)
  for (const p of ws.files()) place(p, files)
  return {
    result: {
      path: folder,
      notes: notes.slice(0, LIST_LIMIT),
      ...(files.length ? { files: files.slice(0, LIST_LIMIT) } : {}),
      subfolders: [...subfolders],
      ...(notes.length > LIST_LIMIT ? { more: notes.length - LIST_LIMIT } : {}),
    },
    activity: { tool, detail: folder || '/' },
  }
}

const currentDocument: Handler = ({ ws, state, visible }) => {
  const tool = 'get_current_document'
  const current = ws.current
  if (!current) return { result: { error: 'no document is open' }, activity: { tool, detail: '' } }
  if (!visible(current.path)) return { result: { error: 'the open document is outside the scope the user chose' }, activity: { tool, detail: current.title } }
  state.reads.set(current.path, { title: current.title, body: current.body, platform: current.platform })
  return {
    result: { path: current.path, title: current.title, selection: current.selection || undefined, ...part(current.body, 0) },
    activity: { tool, detail: current.title },
  }
}

/** A board (read as its outline) or a PDF (read as text). */
async function readFileTool({ ws, a, state }: ToolCtx, path: string): Promise<ToolOutcome> {
  const tool = 'read_note'
  if (!ws.files().includes(path)) return { result: { path, error: 'no such file' }, activity: { tool, detail: path } }
  const text = await ws.readFile(path)
  if (text === null) return { result: { path, error: 'could not be read' }, activity: { tool, detail: path } }
  const name = path.split('/').pop() ?? path
  // A board is kept whole as the base its edits are checked against; the
  // model reads its outline. A PDF is read-only text.
  state.reads.set(path, { title: name, body: text })
  const board = isBoard(path)
  return { result: { path, kind: board ? 'board' : 'pdf', title: name, ...part(board ? boardOutline(text) : text, a.offset) }, activity: { tool, detail: name } }
}

const readNoteTool: Handler = async (c) => {
  const tool = 'read_note'
  const { ws, a, state, visible } = c
  const current = ws.current
  const path = typeof a.path === 'string' ? a.path.trim() : ''
  const isCurrent = Boolean(current && path === current.path)
  const problem = isCurrent ? null : pathProblem(path, 'read')
  if (problem) return { result: { path, error: problem }, activity: { tool, detail: path } }
  if (!visible(path)) return { result: { path, error: 'outside the scope the user chose' }, activity: { tool, detail: path } }
  if (!isCurrent && !/\.md$/i.test(path)) return readFileTool(c, path)
  if (!isCurrent && !ws.paths().includes(path)) return { result: { path, error: 'no such note' }, activity: { tool, detail: path } }
  const note = isCurrent && current ? { title: current.title, body: current.body, platform: current.platform } : await ws.read(path)
  if (!note) return { result: { path, error: 'no such note' }, activity: { tool, detail: path } }
  state.reads.set(path, note)
  return { result: { path, title: note.title, ...part(note.body, a.offset) }, activity: { tool, detail: note.title || path } }
}

const HANDLERS = new Map<unknown, Handler>([
  ['search_vault', searchVault],
  ['read_note', readNoteTool],
  ['list_folder', listFolder],
  ['get_current_document', currentDocument],
])

export async function runTool(call: AgentToolCall, ws: Workspace, scope: AgentScope, state: ToolState): Promise<ToolOutcome> {
  const handler = HANDLERS.get(call.tool)
  if (!handler) {
    return { result: { error: `unknown tool "${call.tool}"; available: ${TOOL_NAMES.join(', ')}` }, activity: { tool: 'unknown', detail: call.tool } }
  }
  return handler({ ws, a: call.args, state, visible: (path) => inScope(path, scope, ws.current?.path) })
}

/** The open note as the agent sees it: live editor content, not the file. */
export interface OpenDoc {
  path: string
  title: string
  platform?: string
  markdown(): string
  selection(): string
  /** Put new markdown into the editor; throws when the editor will not take it. */
  replace(markdown: string): void
}

/** The board open in the whiteboard: read from and written to it live. */
export interface OpenBoard {
  path: string
  /** The scene as it is on screen, as board file text. */
  read(): string
  /** Show this board file text, and save it. */
  replace(text: string): Promise<void>
}

/**
 * Workspace and ChangeTarget over the real vault. The open note is read from
 * and written to the editor, so its unsaved edits are what the agent sees and
 * a change to it goes through the editor's own save (and its copy-on-save
 * rule for delivered meetings) instead of under it.
 */
export function vaultWorkspace(opts: {
  vault: Vault
  /** Full-text search, best first; absent when the index would not open. */
  index?: (query: string) => VaultIndexRow[]
  paths: string[]
  open: OpenDoc | null
  /** Boards and PDFs in the vault. */
  files?: string[]
  /** A vault PDF's text. */
  pdfText?: (path: string) => Promise<string>
  board?: OpenBoard | null
  /** The board or PDF in the main pane. */
  openFile?: string
  mermaid?: (definition: string) => Promise<BoardInsert>
}): Workspace & ChangeTarget {
  const { vault, open } = opts
  const board = opts.board ?? null
  const boardOpen = (path: string) => Boolean(board && path === board.path)
  const pdfs = new Map<string, Promise<string | null>>()
  const abs = (path: string) => vault.io.join(vault.io.root, path)
  const writeText = async (path: string, text: string) => {
    const to = abs(path)
    await vault.io.mkdirs(to.slice(0, to.lastIndexOf('/')))
    await vault.io.writeFileAtomic(to, text)
  }
  const readText = async (path: string): Promise<string | null> => {
    if (boardOpen(path) && board) return board.read()
    try {
      return await vault.io.readFile(abs(path))
    } catch {
      return null
    }
  }
  const isOpen = (path: string) => Boolean(open && path === open.path)
  const readNote = async (path: string): Promise<VaultNote | null> => {
    try {
      return await vault.readNote(path)
    } catch {
      return null
    }
  }
  const stored = async (path: string): Promise<string> => (await readNote(path))?.body ?? ''
  const current: CurrentDoc | null = open ? { path: open.path, title: open.title, body: open.markdown().trim(), selection: open.selection(), platform: open.platform } : null
  const ws: Workspace & ChangeTarget = {
    current,
    ...(opts.openFile ? { openFile: opts.openFile } : {}),
    ...(opts.mermaid ? { mermaid: opts.mermaid } : {}),
    paths: () => opts.paths.filter((p) => !pathProblem(p)),
    files: () => (opts.files ?? []).filter((p) => !pathProblem(p, 'read') && (isBoard(p) || (/\.pdf$/i.test(p) && Boolean(opts.pdfText)))),
    readFile: async (path) => {
      if (isBoard(path)) return readText(path)
      if (!opts.pdfText) return null
      // Read in parts by offset: extract once per request, not once per part.
      if (!pdfs.has(path)) pdfs.set(path, opts.pdfText(path).catch(() => null))
      return pdfs.get(path)!
    },
    search: (query) => {
      if (opts.index) {
        try {
          return opts.index(query).map((h) => ({ path: h.path, title: h.title, updatedAt: h.updatedAt }))
        } catch {
          return [] // a query FTS cannot parse is no result, not a failed run
        }
      }
      // ponytail: no index, so paths stand in for titles; fine as a fallback.
      const matches = nameMatcher(query)
      const hits: SearchHit[] = []
      for (const p of matches ? opts.paths : []) if (matches?.test(p)) hits.push({ path: p, title: p.split('/').pop()?.replace(/\.md$/i, '') ?? p, updatedAt: '' })
      return hits
    },
    read: async (path) => {
      if (isOpen(path) && current) return { title: current.title, body: current.body, platform: current.platform }
      const n = await readNote(path)
      return n ? { title: n.title || path, body: n.body, platform: n.platform } : null
    },
    readBody: async (path) => {
      if (isBoard(path)) return readText(path)
      return isOpen(path) && open ? open.markdown().trim() : ((await readNote(path))?.body ?? null)
    },
    writeBody: async (path, body) => {
      if (isBoard(path)) {
        if (boardOpen(path) && board) await board.replace(body)
        else await writeText(path, body)
        return (await readText(path)) ?? body
      }
      if (isOpen(path) && open) {
        open.replace(body)
        return open.markdown().trim()
      }
      const n = await readNote(path)
      if (!n) throw new Error(`${path}: note not found`)
      // Checked again here, not only when staging: the open meeting a change
      // was aimed at may have been saved as a copy since, and is a file now.
      if (n.platform && n.platform !== 'manual') throw new Error(`${path}: delivered meetings are archives and are never rewritten`)
      await vault.writeNoteAt(path, { ...n, body, updatedAt: new Date().toISOString() })
      return stored(path)
    },
    create: async (path, title, body) => {
      if (isBoard(path)) {
        await writeText(path, body)
        return body
      }
      const id = uuidV7()
      await vault.writeNoteAt(path, {
        id,
        sessionKey: `nota/${Date.now().toString(36)}-${id.slice(-6)}`,
        platform: 'manual',
        updatedAt: new Date().toISOString(),
        title,
        body,
      })
      return stored(path)
    },
    remove: (path) => vault.trash(path),
  }
  return ws
}
