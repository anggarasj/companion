import { describe, expect, it } from 'vitest'
import { EMPTY_BOARD, isBoard, newBoardPath, parseBoard } from './board'

describe('whiteboard files', () => {
  it('recognises .excalidraw files only', () => {
    expect(isBoard('Boards/Plan.excalidraw')).toBe(true)
    expect(isBoard('Plan.EXCALIDRAW')).toBe(true)
    expect(isBoard('Plan.excalidraw.md')).toBe(false)
    expect(isBoard('Plan.md')).toBe(false)
  })

  it('writes a new board Excalidraw itself can open', () => {
    const data = JSON.parse(EMPTY_BOARD)
    expect(data.type).toBe('excalidraw')
    expect(data.elements).toEqual([])
  })

  it('round-trips a board and treats an empty file as an empty board', () => {
    const rect = { id: 'a', type: 'rectangle', x: 1, y: 2 }
    const parsed = parseBoard(JSON.stringify({ type: 'excalidraw', elements: [rect], appState: {}, files: {} }))
    expect(parsed.elements).toEqual([rect])
    expect(parseBoard('')).toEqual({ elements: [], appState: {}, files: {} })
  })

  it('refuses a file that is not JSON rather than opening it blank', () => {
    expect(() => parseBoard('not json')).toThrow()
  })
})

describe('newBoardPath', () => {
  const now = new Date(2026, 9, 5, 12, 46, 34) // local time

  it('names the board after local time, inside the folder', () => {
    expect(newBoardPath('Projects', 'Whiteboard', now, [])).toBe('Projects/Whiteboard 2026-10-05 12.46.34.excalidraw')
    expect(newBoardPath('', 'Whiteboard', now, [])).toBe('Whiteboard 2026-10-05 12.46.34.excalidraw')
  })

  it('never reuses a name already in the vault', () => {
    const taken = ['Whiteboard 2026-10-05 12.46.34.excalidraw', 'Whiteboard 2026-10-05 12.46.34 2.excalidraw']
    expect(newBoardPath('', 'Whiteboard', now, taken)).toBe('Whiteboard 2026-10-05 12.46.34 3.excalidraw')
  })
})
