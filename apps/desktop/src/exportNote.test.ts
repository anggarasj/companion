// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('./editor/mermaid', () => ({ renderMermaid: async () => '<svg></svg>' }))
import type { VaultNote } from '@meetcc/vault'
import {
  buildExportHtml,
  buildExportMarkdown,
  exportNote,
  pageBreaks,
  sanitizeFilename,
  withDiagrams,
} from './exportNote'

const sampleNote: VaultNote = {
  id: 'note-1',
  sessionKey: 'session-1',
  title: 'Interview Notes',
  body: '# Overview\n\nDiscussion about architecture and Node.js.\n\n- Point 1\n- Point 2\n\n| Item | Val |\n| --- | --- |\n| Test | OK |\n',
  status: 'In Progress',
  priority: 'High',
  assignee: 'Badrus',
  dueDate: '2026-10-10',
  startedAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-05T00:00:00Z',
  platform: 'manual',
}

describe('exportNote utilities', () => {
  it('sanitizes filename properly', () => {
    expect(sanitizeFilename('Interview: System Architecture / Design?', 'md')).toBe(
      'Interview- System Architecture - Design-.md',
    )
    expect(sanitizeFilename('', 'pdf')).toBe('untitled.pdf')
  })

  it('builds markdown export with and without metadata and title', () => {
    const full = buildExportMarkdown(sampleNote, { includeMetadata: true, includeTitle: true })
    expect(full.startsWith('---\n')).toBe(true)
    expect(full).toContain('title: "Interview Notes"')
    expect(full).toContain('status: In Progress')
    expect(full).toContain('priority: High')
    expect(full).toContain('assignee: "Badrus"')
    expect(full).toContain('# Overview')

    const clean = buildExportMarkdown(sampleNote, { includeMetadata: false, includeTitle: false })
    expect(clean.startsWith('---')).toBe(false)
    expect(clean).toBe(sampleNote.body)
  })

  it('builds standalone HTML export', () => {
    const html = buildExportHtml(sampleNote, '<h1>Overview</h1><p>Discussion</p>', {
      includeMetadata: true,
      includeTitle: true,
    })
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<title>Interview Notes</title>')
    expect(html).toContain('<h1 class="page-title">Interview Notes</h1>')
    expect(html).toContain('Status')
    expect(html).toContain('In Progress')
    expect(html).toContain('<h1>Overview</h1><p>Discussion</p>')
  })

  it('escapes the title and properties in the HTML export', () => {
    const html = buildExportHtml({ ...sampleNote, title: '<img src=x onerror=alert(1)>' }, '<p>body</p>', {
      includeMetadata: true,
      includeTitle: true,
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('lays out the PDF page as a light page with no outer padding', () => {
    const pdf = buildExportHtml(sampleNote, '<p>body</p>', { includeMetadata: false, includeTitle: true }, true)
    expect(pdf).not.toContain('prefers-color-scheme: dark')
    expect(pdf).toContain('<meta name="color-scheme" content="light">')
    expect(buildExportHtml(sampleNote, '', { includeMetadata: false, includeTitle: true })).toContain(
      'prefers-color-scheme: dark',
    )
  })

  it('renders mermaid blocks as diagrams and keeps a broken one as code', async () => {
    const html =
      '<p>a</p><pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre>' +
      '<pre><code class="language-mermaid">nonsense</code></pre><pre><code class="language-js">x</code></pre>'
    const out = await withDiagrams(html, async (def) => {
      if (def === 'nonsense') throw new Error('Parse error')
      return `<svg data-def="${def}"></svg>`
    })
    const doc = new DOMParser().parseFromString(out, 'text/html')
    expect(doc.querySelectorAll('figure.mermaid svg')).toHaveLength(1)
    expect(doc.querySelector('figure.mermaid svg')?.getAttribute('data-def')).toBe('graph TD; A-->B')
    expect(doc.querySelector('code.language-mermaid')?.textContent).toBe('nonsense')
    expect(doc.querySelector('code.language-js')?.textContent).toBe('x')
  })

  it('breaks PDF pages between blocks, never inside one that fits', () => {
    // blocks end at 300, 600, 900, 1200; a page holds 1000
    expect(pageBreaks([300, 600, 900, 1200], 1200, 1000)).toEqual([900, 1200])
    // fits on one page
    expect(pageBreaks([100], 400, 1000)).toEqual([400])
    // a single block taller than a page is cut at the page edge
    expect(pageBreaks([2500], 2500, 1000)).toEqual([1000, 2000, 2500])
  })

  it('saves through the native save dialog, opened in the note folder', async () => {
    invokeMock.mockResolvedValue('/Users/a/Desktop/picked.md')
    for (const [format, name, type] of [
      ['markdown', 'Interview Notes.md', 'title: "Interview Notes"'],
      ['html', 'Interview Notes.html', '<!DOCTYPE html>'],
    ] as const) {
      invokeMock.mockClear()
      const saved = await exportNote(sampleNote, '<p>body</p>', { format, includeMetadata: true, includeTitle: true }, 'Projects')
      expect(saved).toBe('/Users/a/Desktop/picked.md')
      expect(invokeMock).toHaveBeenCalledTimes(1)
      const [cmd, args] = invokeMock.mock.calls[0] as [string, { name: string; dir: string; bytes: number[] }]
      expect(cmd).toBe('export_file')
      expect(args.name).toBe(name)
      expect(args.dir).toBe('Projects')
      expect(new TextDecoder().decode(new Uint8Array(args.bytes))).toContain(type)
    }
  })

  it('reports a cancelled dialog as null', async () => {
    invokeMock.mockResolvedValue(null)
    expect(await exportNote(sampleNote, '', { format: 'markdown', includeMetadata: false, includeTitle: true })).toBeNull()
  })
})
