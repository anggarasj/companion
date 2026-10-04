// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
import type { VaultNote } from '@meetcc/vault'
import {
  buildExportHtml,
  buildExportMarkdown,
  buildExportPdf,
  exportNote,
  sanitizeFilename,
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

  it('builds PDF blob from note', () => {
    const blob = buildExportPdf(sampleNote, { includeMetadata: true, includeTitle: true })
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(0)
    expect(blob.type).toBe('application/pdf')
  })

  it('saves every format through the native save dialog command', async () => {
    invokeMock.mockResolvedValue('/Users/a/Desktop/picked.md')
    for (const [format, name, type] of [
      ['markdown', 'Interview Notes.md', 'title: "Interview Notes"'],
      ['html', 'Interview Notes.html', '<!DOCTYPE html>'],
      ['pdf', 'Interview Notes.pdf', '%PDF-'],
    ] as const) {
      invokeMock.mockClear()
      const saved = await exportNote(sampleNote, '<p>body</p>', { format, includeMetadata: true, includeTitle: true })
      expect(saved).toBe('/Users/a/Desktop/picked.md')
      expect(invokeMock).toHaveBeenCalledTimes(1)
      const [cmd, args] = invokeMock.mock.calls[0] as [string, { name: string; bytes: number[] }]
      expect(cmd).toBe('export_file')
      expect(args.name).toBe(name)
      expect(new TextDecoder().decode(new Uint8Array(args.bytes))).toContain(type)
    }
  })

  it('reports a cancelled dialog as null', async () => {
    invokeMock.mockResolvedValue(null)
    expect(await exportNote(sampleNote, '', { format: 'markdown', includeMetadata: false, includeTitle: true })).toBeNull()
  })
})
