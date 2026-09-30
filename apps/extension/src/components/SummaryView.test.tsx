// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Analysis, AnalysisRecord, Meeting } from '@meetcc/shared'
import { t } from '@meetcc/shared/i18n'
import { ToastProvider } from '@meetcc/ui'
import { toMarkdown } from '@meetcc/exporters/markdown'
import { toPdf } from '@meetcc/exporters/pdf'
import { toObsidian } from '@meetcc/exporters/obsidian'
import { SummaryView } from './SummaryView'
import { renderPng } from '../lib/mermaid'

vi.mock('@meetcc/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meetcc/shared')>()
  return {
    ...actual,
    appendAudit: vi.fn(async () => undefined),
    getContext: vi.fn(async () => ''),
    getMeetingTags: vi.fn(async () => []),
    getMiniContexts: vi.fn(async () => []),
    watchStorage: vi.fn(() => () => undefined),
  }
})
vi.mock('../lib/db', () => ({ db: vi.fn(async () => []) }))
vi.mock('@meetcc/exporters/markdown', () => ({
  toMarkdown: vi.fn(() => '# Actual meeting summary'),
}))
vi.mock('@meetcc/exporters/obsidian', () => ({
  toObsidian: vi.fn(() => '# Obsidian meeting summary'),
  obsidianPath: vi.fn(() => 'Meetings/summary.md'),
}))
vi.mock('@meetcc/exporters/pdf', () => ({
  toPdf: vi.fn(() => new Blob(['summary pdf'])),
}))
vi.mock('../lib/logo', () => ({ orgLogoPng: vi.fn(async () => null) }))
vi.mock('../lib/mermaid', () => ({
  renderPng: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,diagram', wPx: 320, hPx: 200 })),
}))

const meeting: Meeting = {
  id: 'summary-meeting',
  meta: { id: 'summary-meeting', startedAt: '2026-09-28T10:00:00Z', lastSeenAt: '2026-09-28T10:05:00Z' },
  entries: [{ speaker: 'Rani', text: 'Discussed a plan.', time: '2026-09-28T10:02:00Z' }],
}
const analysis: Analysis = {
  executiveSummary: 'Summary content, not generated document content.',
  timeline: [],
  keyDiscussions: [],
  decisions: [],
  actionItems: [],
  risks: [],
  openQuestions: [],
  nextSteps: [],
  diagrams: [{ title: 'Summary flow', type: 'flowchart', mermaid: 'flowchart TD\nA-->B' }],
}
const record: AnalysisRecord = {
  status: 'done',
  analysis,
  generatedAt: '2026-09-28T10:05:00Z',
  provider: 'builtin',
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('summary exports', () => {
  it('exports the analysis as Markdown rather than generating a document', async () => {
    const sendMessage = vi.fn()
    vi.stubGlobal('chrome', { runtime: { sendMessage } })
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:summary'), revokeObjectURL: vi.fn() })
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <SummaryView meeting={meeting} record={record} live={false} />
      </ToastProvider>,
    )

    await user.click(screen.getByRole('button', { name: t('ext.docs.markdownExport') }))
    await user.click(screen.getByRole('button', { name: t('ext.docs.obsidianExport') }))

    expect(toMarkdown).toHaveBeenCalledWith(meeting, analysis)
    expect(toObsidian).toHaveBeenCalledWith(meeting, analysis)
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'generate-doc' }))
  })
  it('keeps summary regeneration available after analysis completes', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('chrome', { runtime: { sendMessage } })
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <SummaryView meeting={meeting} record={record} live />
      </ToastProvider>,
    )

    await user.click(screen.getByRole('button', { name: t('ext.summary.restart') }))

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'regenerate',
      meetingId: meeting.id,
    })
  })


  it('builds the summary PDF with rendered analysis diagrams', async () => {
    const createObjectURL = vi.fn(() => 'blob:summary-pdf')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() } })
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <SummaryView meeting={meeting} record={record} live={false} />
      </ToastProvider>,
    )

    await user.click(screen.getByRole('button', { name: t('ext.docs.pdfExport') }))

    await waitFor(() => expect(toPdf).toHaveBeenCalled())
    expect(renderPng).toHaveBeenCalledWith('flowchart TD\nA-->B')
    expect(toPdf).toHaveBeenCalledWith(
      meeting,
      analysis,
      [{ title: 'Summary flow', dataUrl: 'data:image/png;base64,diagram', wPx: 320, hPx: 200 }],
      null,
    )
  })

  it('sends the summary to Desktop through the summary delivery action', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('chrome', { runtime: { sendMessage } })
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <SummaryView meeting={meeting} record={record} live={false} />
      </ToastProvider>,
    )

    await user.click(
      screen.getByRole('button', {
        name: t('ext.docs.desktopExportDocument', { label: 'summary' }),
      }),
    )

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'bridge-deliver-meeting',
      meetingId: meeting.id,
    })
  })
})
