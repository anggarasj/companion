// The Vault Agent's vocabulary, as plain data. Nothing here imports React,
// Tiptap or a provider: the loop in runner.ts speaks it to any AIClient, and
// the sidebar renders it.
import type { BoardEdge, BoardEdit, BoardInsert, BoardNode } from '../board'

/** Where the agent may look. A narrower scope is a hard limit, never a hint. */
export type AgentScope =
  | { kind: 'vault' }
  | { kind: 'folder'; folder: string }
  | { kind: 'files'; paths: string[] }
  | { kind: 'document' }

/** The tools the model may call. All read; none writes. */
export const TOOL_NAMES = ['search_vault', 'read_note', 'list_folder', 'get_current_document'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export interface AgentToolCall {
  tool: string
  args: Record<string, unknown>
}

/** A file the agent actually read, cited by path. */
export interface SourceRef {
  path: string
  title: string
}

export interface ReviewFinding {
  severity: 'info' | 'warning' | 'critical'
  title: string
  explanation: string
  sources: { path: string; excerpt?: string }[]
  suggestedFix?: string
}

export interface CreateNoteChange {
  type: 'create_note'
  path: string
  title: string
  body: string
}
export interface ReplaceTextChange {
  type: 'replace_text'
  path: string
  oldText: string
  newText: string
}
export interface AppendSectionChange {
  type: 'append_section'
  path: string
  markdown: string
}
export interface ReplaceBodyChange {
  type: 'replace_body'
  path: string
  body: string
}
/** A new Excalidraw board, from nodes and edges the agent describes. */
export interface CreateBoardChange {
  type: 'create_board'
  path: string
  nodes: BoardNode[]
  edges: BoardEdge[]
  /** Set when the board came from Mermaid, by the converter, not the model. */
  insert?: BoardInsert
}
/** Add to, relabel or remove from an existing board, by element id. */
export interface EditBoardChange {
  type: 'edit_board'
  path: string
  edit: BoardEdit
}
export type ProposedChange = CreateNoteChange | ReplaceTextChange | AppendSectionChange | ReplaceBodyChange | CreateBoardChange | EditBoardChange

/**
 * A change that passed validation, with what it was computed against. `base`
 * is the note body the agent read (null for a new note); `preview` is that
 * body with only this change applied. A board's body is Excalidraw JSON, so
 * `view` carries the readable outline of both sides for the diff.
 */
export type StagedChange = ProposedChange & {
  id: string
  base: string | null
  preview: string
  view?: { before: string; after: string }
}

export interface ChangeSet {
  id: string
  summary: string
  changes: StagedChange[]
}

/** One model turn, as parsed. */
export type AgentStep =
  | { type: 'tool_calls'; status?: string; calls: AgentToolCall[] }
  | {
      type: 'final'
      answer?: string
      summary?: string
      sources?: string[]
      findings?: unknown[]
      changes?: unknown[]
      open?: string
    }

export interface AgentResult {
  answer?: string
  sources: SourceRef[]
  findings: ReviewFinding[]
  changeSet?: ChangeSet
  /** Proposed changes refused by validation, with why — shown, never applied. */
  rejected: { path: string; reason: string }[]
  /** A note the user asked to have opened. */
  open?: string
  /** Every note read during the run, for callers that ground on them. */
  reads: Map<string, { title: string; body: string }>
  steps: number
}

/** A previous exchange, compacted for the next prompt. */
export interface AgentTurn {
  request: string
  /** The answer (or a summary of the result), already shortened. */
  reply: string
  /** Documents shown to the user, numbered in display order (1-based). */
  refs: SourceRef[]
}

/** The note on screen, when there is one. */
export interface CurrentDoc {
  path: string
  title: string
  body: string
  selection: string
  platform?: string
}

export interface SearchHit {
  path: string
  title: string
  updatedAt: string
}

/** What the read tools need from the app: an index, a list, a reader. */
export interface Workspace {
  /** Full-text hits, best first. */
  search(query: string): SearchHit[]
  /** Every note path in the vault (vault-relative, `.md`). */
  paths(): string[]
  /** Boards (`.excalidraw`) and PDFs the agent may read. */
  files(): string[]
  /** A board's file text, or a PDF's extracted text; null when it is not there. */
  readFile(path: string): Promise<string | null>
  /** Mermaid to finished board elements; absent where there is no DOM to render with. */
  mermaid?(definition: string): Promise<BoardInsert>
  /** A note's title and body, or null when it is not there. */
  read(path: string): Promise<{ title: string; body: string; platform?: string } | null>
  current: CurrentDoc | null
  /** The board or PDF on screen instead of a note, if any. */
  openFile?: string
}

/** What applying needs: body-level reads and writes over the vault (a board's body is its file). */
export interface ChangeTarget {
  /** The note body now, or null when no note is at `path`. */
  readBody(path: string): Promise<string | null>
  /** Replace the body; resolves with the body as it was stored. */
  writeBody(path: string, body: string): Promise<string>
  /** Create a note; resolves with the body as it was stored. */
  create(path: string, title: string, body: string): Promise<string>
  /** Take a note away again (to the vault's trash). */
  remove(path: string): Promise<void>
}

/** What applying a change left behind, enough to undo it. */
export interface AppliedChange {
  path: string
  /** Body before; null when the change created the note. */
  before: string | null
  after: string
}
