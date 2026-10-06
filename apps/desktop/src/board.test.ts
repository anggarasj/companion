import { describe, expect, it } from 'vitest'
import { boardOutline, createBoard, editBoard, EMPTY_BOARD, isBoard, newBoardPath, parseBoard, sameBoard } from './board'

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

describe('boards for the AI agent', () => {
  const flow = () =>
    createBoard(
      [
        { id: 'a', label: 'Login page' },
        { id: 'b', label: 'Auth service', shape: 'ellipse' },
      ],
      [{ from: 'a', to: 'b', label: 'POST /token' }],
    )

  it('expands nodes and edges into labelled shapes and a bound arrow', () => {
    const text = flow()
    const els = parseBoard(text).elements as unknown as { id: string; type: string; containerId?: string; boundElements?: { id: string }[]; startBinding?: { elementId: string } }[]
    const [login, auth] = els.filter((e) => e.type !== 'text' && e.type !== 'arrow')
    const arrow = els.find((e) => e.type === 'arrow')!
    expect(arrow.startBinding?.elementId).toBe(login.id)
    expect(login.boundElements?.map((b) => b.id)).toContain(arrow.id)
    expect(els.filter((e) => e.containerId === auth.id)).toHaveLength(1)
    const outline = boardOutline(text)
    expect(outline).toContain('rectangle "Login page"')
    expect(outline).toContain('ellipse "Auth service"')
    expect(outline).toMatch(new RegExp(`arrow #${login.id} → #${auth.id} "POST /token"`))
  })

  it('edits by id: relabel, remove with its label and arrows, add connected to an existing shape', () => {
    const text = flow()
    const els = parseBoard(text).elements as unknown as { id: string; type: string }[]
    const [login, auth] = els.filter((e) => e.type === 'rectangle' || e.type === 'ellipse')
    const edited = editBoard(text, {
      relabel: [{ id: login.id, text: 'Sign-in page' }],
      remove: [auth.id],
      add: { nodes: [{ id: 'n', label: 'OIDC provider' }], edges: [{ from: login.id, to: 'n' }] },
    })
    const outline = boardOutline(edited)
    expect(outline).toContain('"Sign-in page"')
    expect(outline).not.toContain('Auth service')
    expect(outline).not.toContain('POST /token')
    expect(outline).toContain('"OIDC provider"')
    expect(outline.match(/arrow/g)).toHaveLength(1)
  })

  it('refuses an edit naming something that is not on the board', () => {
    expect(() => editBoard(flow(), { remove: ['ghost'] })).toThrow('no element "ghost"')
    expect(() => editBoard(flow(), { add: { edges: [{ from: 'ghost', to: 'x' }] } })).toThrow('no shape "ghost"')
  })

  it('a board re-serialized by Excalidraw is still the same board', () => {
    const text = flow()
    const data = JSON.parse(text)
    data.elements = data.elements.map((e: object) => ({ ...e, version: 7, customField: true }))
    data.appState = { viewBackgroundColor: '#fff' }
    expect(sameBoard(text, JSON.stringify(data))).toBe(true)
    expect(sameBoard(text, editBoard(text, { add: { nodes: [{ id: 'x', label: 'More' }] } }))).toBe(false)
  })
})

describe('clearing a board', () => {
  it('removes shapes and the arrow between them in one edit, whatever order they are listed in', () => {
    const text = createBoard([{ id: 'a', label: '' }, { id: 'b', label: '' }], [{ from: 'a', to: 'b' }])
    const ids = (parseBoard(text).elements as unknown as { id: string; type: string }[]).filter((e) => e.type !== 'text').map((e) => e.id)
    const cleared = editBoard(text, { remove: ids, add: { nodes: [{ id: 'c', label: 'Client' }] } })
    expect(boardOutline(cleared)).toMatch(/^#\S+ rectangle "Client"/)
    expect(boardOutline(cleared).split('\n')).toHaveLength(1)
    expect(() => editBoard(text, { remove: [...ids, 'ghost'] })).toThrow('no element "ghost"')
  })
})
