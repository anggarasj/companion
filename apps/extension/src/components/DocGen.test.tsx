// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOC_META } from '@meetcc/ai'
import { loadDocProgress, loadDocs, type Analysis, type Meeting } from '@meetcc/shared'
import { t } from '@meetcc/shared/i18n'
import { ToastProvider } from '@meetcc/ui'
import { DocumentOutputs } from './DocGen'

vi.mock('@meetcc/shared', () => ({
  DOCPROG_PREFIX: 'doc-progress:',
  DOCS_PREFIX: 'docs:',
  loadDocProgress: vi.fn(async () => null),
  loadDocs: vi.fn(async () => ({})),
  watchStorage: vi.fn(() => () => undefined),
}))
vi.mock('../lib/db', () => ({ db: vi.fn(async () => []) }))

const meeting: Meeting = {
  id: 'meeting#2026-09-28T10:00',
  meta: { id: 'meeting#2026-09-28T10:00', startedAt: '2026-09-28T10:00:00Z', lastSeenAt: '2026-09-28T10:05:00Z' },
  entries: [{ speaker: 'Rani', text: 'Kita bahas anggaran.', time: '2026-09-28T10:02:00Z' }],
}
const analysis = {
  executiveSummary: 'Bahas anggaran dan vendor.',
  timeline: [
    { time: '00:02', topic: 'Anggaran' },
    { time: '00:05', topic: 'Vendor' },
  ],
  keyDiscussions: [],
  decisions: [],
  actionItems: [],
  risks: [],
  openQuestions: [],
  nextSteps: [],
  diagrams: [],
} as Analysis

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.mocked(loadDocProgress).mockResolvedValue(null)
  vi.mocked(loadDocs).mockResolvedValue({})
})

describe('Notulen timeline scope', () => {
  it('starts with every topic selected and sends only the remaining topic', async () => {
    vi.mocked(loadDocs)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        notulen: {
          content: '# Notulen generated output',
          generatedAt: '2026-09-29T00:00:00.000Z',
          provider: 'openai',
        },
      })
    const sendMessage = vi.fn(async () => ({ ok: true, content: '# Notulen' }))
    vi.stubGlobal('chrome', { runtime: { sendMessage } })
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <DocumentOutputs meeting={meeting} analysis={analysis} />
      </ToastProvider>,
    )
    expect(screen.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual([
      'notulen',
      'brd',
      'prd',
      'recap',
    ])
    expect(
      (screen.getByRole('radio', { name: DOC_META.notulen.label }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(screen.getByText(t('ext.docs.timelineScope'))).toBeTruthy()
    const budget = screen.getByRole('checkbox', { name: /00:02 Anggaran/ })
    const vendor = screen.getByRole('checkbox', { name: /00:05 Vendor/ })
    expect((budget as HTMLInputElement).checked).toBe(true)
    expect((vendor as HTMLInputElement).checked).toBe(true)
    await user.click(vendor)
    await user.click(
      screen.getByRole('button', {
        name: t('ext.docs.generateDocument'),
      }),
    )

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'generate-doc',
      meetingId: meeting.id,
      docType: 'notulen',
      templateId: undefined,
      timelineIndices: [0],
    })
    expect(screen.getByText(t('ext.docs.timelineScopeHint'))).toBeTruthy()
    expect(await screen.findByText('# Notulen generated output')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: t('ext.docs.exportResult') }))
    expect(screen.getByRole('menuitem', { name: t('ext.docs.markdownExport') })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: t('ext.docs.obsidianExport') })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: t('ext.docs.pdfExport') })).toBeTruthy()
    await user.click(
      screen.getByRole('menuitem', {
        name: t('ext.docs.desktopExportDocument', { label: DOC_META.notulen.label }),
      }),
    )
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: 'bridge-export-document',
      meetingId: meeting.id,
      docType: 'notulen',
      generatedAt: '2026-09-29T00:00:00.000Z',
    })
  })
  it('preserves deselections across timeline updates and selects added topics', async () => {
    const user = userEvent.setup()
    const view = render(
      <ToastProvider>
        <DocumentOutputs meeting={meeting} analysis={analysis} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('checkbox', { name: /00:05 Vendor/ }))

    const refreshedAnalysis = {
      ...analysis,
      timeline: [
        { time: '00:02', topic: 'Updated budget' },
        { time: '00:05', topic: 'Updated vendor' },
        { time: '00:08', topic: 'New risk' },
      ],
    }
    view.rerender(
      <ToastProvider>
        <DocumentOutputs meeting={meeting} analysis={refreshedAnalysis} />
      </ToastProvider>,
    )

    expect(
      (screen.getByRole('checkbox', { name: /00:02 Updated budget/ }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(
      (screen.getByRole('checkbox', { name: /00:05 Updated vendor/ }) as HTMLInputElement).checked,
    ).toBe(false)
    expect(
      (screen.getByRole('checkbox', { name: /00:08 New risk/ }) as HTMLInputElement).checked,
    ).toBe(true)
  })

  it('resets scope when the meeting and timeline change after mount', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, content: '# New document' }))
    vi.stubGlobal('chrome', { runtime: { sendMessage } })
    const user = userEvent.setup()
    const view = render(
      <ToastProvider>
        <DocumentOutputs meeting={meeting} analysis={analysis} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('checkbox', { name: /00:05 Vendor/ }))

    const nextMeeting = { ...meeting, id: 'next-meeting' }
    const nextAnalysis = {
      ...analysis,
      timeline: [
        { time: '00:08', topic: 'Risiko' },
        { time: '00:10', topic: 'Rencana' },
      ],
    }
    view.rerender(
      <ToastProvider>
        <DocumentOutputs meeting={nextMeeting} analysis={nextAnalysis} />
      </ToastProvider>,
    )
    expect((screen.getByRole('checkbox', { name: /00:08 Risiko/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: /00:10 Rencana/ }) as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('checkbox', { name: /00:10 Rencana/ }))
    await user.click(screen.getByRole('button', { name: t('ext.docs.generateDocument') }))

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'generate-doc',
      meetingId: nextMeeting.id,
      docType: 'notulen',
      templateId: undefined,
      timelineIndices: [0],
    })
  })

  it('selects all topics when analysis loads after mount', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, content: '# Loaded analysis' }))
    vi.stubGlobal('chrome', { runtime: { sendMessage } })
    const user = userEvent.setup()
    const view = render(
      <ToastProvider>
        <DocumentOutputs meeting={meeting} analysis={null} />
      </ToastProvider>,
    )
    view.rerender(
      <ToastProvider>
        <DocumentOutputs meeting={meeting} analysis={analysis} />
      </ToastProvider>,
    )
    expect((screen.getByRole('checkbox', { name: /00:02 Anggaran/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: /00:05 Vendor/ }) as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('button', { name: t('ext.docs.generateDocument') }))
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'generate-doc',
      meetingId: meeting.id,
      docType: 'notulen',
      templateId: undefined,
      timelineIndices: [0, 1],
    })
  })
  it('does not allow a loaded timeline to have no selected topic', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, content: '# One topic' }))
    vi.stubGlobal('chrome', { runtime: { sendMessage } })
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <DocumentOutputs
          meeting={meeting}
          analysis={{ ...analysis, timeline: [{ time: '00:01', topic: 'Only topic' }] }}
        />
      </ToastProvider>,
    )

    const topic = screen.getByRole('checkbox', { name: /00:01 Only topic/ })
    await user.click(topic)
    expect((topic as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('button', { name: t('ext.docs.generateDocument') }))
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'generate-doc',
      meetingId: meeting.id,
      docType: 'notulen',
      templateId: undefined,
      timelineIndices: [0],
    })
  })


  it('keeps timeline scope available for non-Notulen templates', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, content: '# BRD' }))
    vi.stubGlobal('chrome', { runtime: { sendMessage } })
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <DocumentOutputs meeting={meeting} analysis={analysis} />
      </ToastProvider>,
    )

    await user.click(screen.getByRole('radio', { name: DOC_META.brd.label }))
    expect(screen.getByRole('checkbox', { name: /00:05 Vendor/ })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: t('ext.docs.generateDocument') }))

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'generate-doc',
      meetingId: meeting.id,
      docType: 'brd',
      templateId: undefined,
      timelineIndices: [0, 1],
    })
  })
  it('does not claim a document was generated without returned content', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, data: [] }))
    vi.stubGlobal('chrome', { runtime: { sendMessage } })
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <DocumentOutputs meeting={meeting} analysis={analysis} />
      </ToastProvider>,
    )

    await user.click(
      screen.getByRole('button', {
        name: t('ext.docs.generateDocument'),
      }),
    )

    expect(
      await screen.findByText(t('ext.failed', { error: t('ext.docs.noOutput') })),
    ).toBeTruthy()
    expect(screen.queryByText(t('ext.docs.done', { label: DOC_META.notulen.label }))).toBeNull()
  })
  it('transfers the transcript to Desktop until a generated document exists', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('chrome', { runtime: { sendMessage } })
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <DocumentOutputs meeting={meeting} analysis={null} />
      </ToastProvider>,
    )

    await user.click(screen.getByRole('button', { name: t('ext.docs.exportResult') }))
    expect(screen.getByText(t('ext.docs.exportTranscriptHint'))).toBeTruthy()
    await user.click(
      screen.getByRole('menuitem', { name: t('ext.docs.desktopExportTranscript') }),
    )

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'bridge-deliver-transcript',
      meetingId: meeting.id,
    })
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'generate-doc' }),
    )
  })
  it('shows the real generation percent while a document is running', async () => {
    vi.mocked(loadDocProgress).mockResolvedValue({
      type: 'notulen',
      step: 2,
      total: 5,
      label: 'Review',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    render(
      <ToastProvider>
        <DocumentOutputs meeting={meeting} analysis={analysis} />
      </ToastProvider>,
    )

    const progress = await screen.findByRole('progressbar', { name: t('ext.docs.generating') })
    expect(progress.getAttribute('aria-valuenow')).toBe('40')
    expect(
      screen.getByRole('button', {
        name: t('ext.docs.generatingPercent', { label: DOC_META.notulen.label, pct: 40 }),
      }),
    ).toBeTruthy()
  })
})
