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
