import { useCallback, useEffect, useRef, useState } from 'react'
import { t, formatDateTime } from '@meetcc/shared/i18n'
import { DOC_META } from '@meetcc/ai'
import { toMarkdown } from '@meetcc/exporters/markdown'
import { obsidianPath, toObsidian, toObsidianDocument } from '@meetcc/exporters/obsidian'
import { GATE_EVENT } from '@meetcc/exporters/gate'
import { classifyBridgeError } from '../lib/bridgeError'
import {
  DOCPROG_PREFIX,
  DOCS_PREFIX,
  loadDocProgress,
  loadDocs,
  watchStorage,
  appendAudit,
  type DocProgressRecord,
  type DocType,
  type Analysis,
  type Meeting,
  type MeetingDocs,
  type StoredDoc,
} from '@meetcc/shared'
import { lazyImport } from '../lib/lazy'
import { db } from '../lib/db'
import { RadioGroup, useToast } from '@meetcc/ui'
import { Button } from '@/components/ui/button'
import {
  ChevronDown,
  Download,
  FileCode,
  FileDown,
  FileText,
  RefreshCw,
  Send,
  Sparkles,
} from 'lucide-react'
import { TimelineScopeList } from './TimelineScopeList'

const TYPES: DocType[] = ['notulen', 'brd', 'prd', 'recap']
const EMPTY_TIMELINE: Analysis['timeline'] = []
type DocumentExport = 'markdown' | 'obsidian' | 'pdf' | 'desktop'

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

interface Props {
  meeting: Meeting
  analysis: Analysis | null
  live: boolean
  selectedTimeline: Set<number>
  indeterminateTimeline: Set<number>
  onToggleTimeline: (index: number, checked: boolean) => void
  excludedEntries: Set<number>
}

export function DocumentOutputs({
  meeting,
  analysis,
  live,
  selectedTimeline,
  onToggleTimeline,
  indeterminateTimeline,
  excludedEntries,
}: Props) {
  const [type, setType] = useState<DocType>('notulen')
  const [docs, setDocs] = useState<MeetingDocs>({})
  const [prog, setProg] = useState<DocProgressRecord | null>(null)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [desktopBusy, setDesktopBusy] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const toast = useToast()

  // P2.1 — an optional user template steers the document's structure.
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([])
  const [templateId, setTemplateId] = useState('')
  const timeline = analysis?.timeline ?? EMPTY_TIMELINE
  const includedEntryCount = meeting.entries.length - excludedEntries.size
  const regenerateSummary = async (): Promise<void> => {
    setSummaryBusy(true)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'regenerate',
        meetingId: meeting.id,
      })
      if (response?.ok) {
        toast('success', live ? t('ext.summary.momDone') : t('ext.summary.notesDone'))
      } else {
        toast('error', t('ext.failed', { error: response?.error ?? response?.reason ?? t('ext.unknownError') }))
      }
    } catch (error) {
      toast('error', t('ext.failed', { error: (error as Error).message }))
    } finally {
      setSummaryBusy(false)
    }
  }


  useEffect(() => {
    let alive = true
    void db<{ id: string; name: string }[]>('templates', { kind: 'doc' })
      .then((t) => alive && setTemplates(t))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const reload = useCallback(async (): Promise<MeetingDocs> => {
    const [nextDocs, nextProgress] = await Promise.all([
      loadDocs(meeting.id),
      loadDocProgress(meeting.id),
    ])
    setDocs(nextDocs)
    setProg(nextProgress)
    return nextDocs
  }, [meeting.id])

  useEffect(() => {
    void reload().catch(() => undefined)
    return watchStorage(() => {
      void reload().catch(() => undefined)
    }, [DOCS_PREFIX, DOCPROG_PREFIX])
  }, [reload])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!exportMenuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!exportMenuRef.current?.contains(event.target as Node)) setExportMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExportMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [exportMenuOpen])

  const current = docs[type]
  const meta = DOC_META[type]

  // progress belongs to the type being generated; stale updatedAt = crashed run
  const active = prog && prog.type === type ? prog : null
  const stalled = active ? now - Date.parse(active.updatedAt) > 90_000 : false
  const running = !!active && !stalled
  const pct = active && active.total > 0 ? Math.round((active.step / active.total) * 100) : 0
  // any type currently generating (blocks starting another to keep one at a time)
  const anyRunning = prog ? now - Date.parse(prog.updatedAt) <= 90_000 : false


  const generate = async (
    docType: DocType,
    announce = true,
  ): Promise<StoredDoc | null> => {
    if (includedEntryCount <= 0) {
      toast('error', t('ext.docs.noMessagesSelected'))
      return null
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'generate-doc',
        meetingId: meeting.id,
        docType,
        templateId: templateId || undefined,
        ...(timeline.length ? { timelineIndices: [...selectedTimeline].sort((a, b) => a - b) } : {}),
        ...(excludedEntries.size
          ? { excludedEntryIndices: [...excludedEntries].sort((a, b) => a - b) }
          : {}),
      })
      if (!response?.ok || typeof response.content !== 'string' || !response.content.trim()) {
        toast('error', t('ext.failed', { error: response?.error ?? t('ext.docs.noOutput') }))
        return null
      }
      const saved = (await reload())[docType]
      if (!saved?.content.trim()) {
        toast('error', t('ext.failed', { error: t('ext.docs.noOutput') }))
        return null
      }
      if (announce) toast('success', t('ext.docs.done', { label: DOC_META[docType].label }))
      return saved
    } catch (error) {
      toast('error', t('ext.failed', { error: (error as Error).message }))
      return null
    }
  }

  const exportPdf = async (document: StoredDoc): Promise<void> => {
    setPdfBusy(true)
    try {
      const [{ docToPdf }, { orgLogoPng }] = await Promise.all([
        lazyImport(() => import('@meetcc/exporters/docpdf')),
        lazyImport(() => import('../lib/logo')),
      ])
      const logo = await orgLogoPng()
      downloadBlob(
        `${meeting.id}-${meta.filename}.pdf`,
        docToPdf(meeting, meta.label, document.content, logo),
      )
      toast('success', t('ext.docs.pdfDownloaded'))
    } catch (e) {
      toast('error', t('ext.docs.pdfFailed', { error: (e as Error).message }))
    } finally {
      setPdfBusy(false)
    }
  }

  const reportDesktopError = (error: string): void => {
    const classified = classifyBridgeError(error)
    toast(
      'error',
      classified === 'not_found' || classified === 'not_registered'
        ? t('ext.summary.desktopNotConnected')
        : t('ext.summary.desktopFailed', { error: error || t('ext.unknownError') }),
    )
  }


  const sendTranscriptToDesktop = async (): Promise<void> => {
    setDesktopBusy(true)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'bridge-deliver-transcript',
        meetingId: meeting.id,
      })
      if (response?.ok) toast('success', t('ext.docs.transcriptSentDesktop'))
      else reportDesktopError(response?.error ?? '')
    } catch (error) {
      toast('error', t('ext.summary.desktopFailed', { error: (error as Error).message }))
    } finally {
      setDesktopBusy(false)
    }
  }

  const sendDocumentToDesktop = async (document: StoredDoc): Promise<void> => {
    setDesktopBusy(true)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'bridge-export-document',
        meetingId: meeting.id,
        docType: type,
        generatedAt: document.generatedAt,
      })
      if (response?.ok) {
        toast('success', t('ext.docs.documentSentDesktop', { label: meta.label }))
      } else {
        reportDesktopError(response?.error ?? '')
      }
    } catch (error) {
      toast('error', t('ext.summary.desktopFailed', { error: (error as Error).message }))
    } finally {
      setDesktopBusy(false)
    }
  }
  const exportResult = async (format: DocumentExport): Promise<void> => {
    setExportMenuOpen(false)
    if (format === 'desktop' && !current) {
      await sendTranscriptToDesktop()
      return
    }
    const document = current ?? (await generate(type, false))
    if (!document) return

    if (format === 'markdown') {
      downloadBlob(
        `${meeting.id}-${meta.filename}.md`,
        new Blob([document.content], { type: 'text/markdown' }),
      )
      toast('success', t('ext.docs.markdownDownloaded', { label: meta.label }))
    } else if (format === 'obsidian') {
      const output = toObsidianDocument(meeting, type, document.content)
      downloadBlob(output.path, new Blob([output.content], { type: 'text/markdown' }))
      void appendAudit(GATE_EVENT, 'meetings=1').catch(() => undefined)
      toast('success', t('ext.docs.obsidianDownloaded', { label: meta.label }))
    } else if (format === 'pdf') {
      await exportPdf(document)
    } else {
      await sendDocumentToDesktop(document)
    }
  }
  const exportSummary = async (format: DocumentExport): Promise<void> => {
    setExportMenuOpen(false)
    if (!analysis) return

    if (format === 'markdown') {
      downloadBlob(
        `${meeting.id}-summary.md`,
        new Blob([toMarkdown(meeting, analysis)], { type: 'text/markdown' }),
      )
      toast('success', t('ext.docs.markdownDownloaded', { label: t('ext.summary.label') }))
    } else if (format === 'obsidian') {
      const path = obsidianPath(meeting)
      const filename = path.split(/[\\/]/).pop() || path
      downloadBlob(
        filename,
        new Blob([toObsidian(meeting, analysis)], { type: 'text/markdown' }),
      )
      void appendAudit(GATE_EVENT, 'meetings=1').catch(() => undefined)
      toast('success', t('ext.docs.obsidianDownloaded', { label: t('ext.summary.label') }))
    } else if (format === 'pdf') {
      setPdfBusy(true)
      try {
        const [{ toPdf }, { orgLogoPng }] = await Promise.all([
          lazyImport(() => import('@meetcc/exporters/pdf')),
          lazyImport(() => import('../lib/logo')),
        ])
        const diagrams: { title: string; dataUrl: string; wPx: number; hPx: number }[] = []
        if (analysis.diagrams?.length) {
          const { renderPng } = await lazyImport(() => import('../lib/mermaid'))
          for (const diagram of analysis.diagrams) {
            try {
              const rendered = await renderPng(diagram.mermaid)
              diagrams.push({ title: diagram.title, ...rendered })
            } catch {
              // Skip invalid diagrams while preserving the rest of the summary.
            }
          }
        }
        downloadBlob(
          `${meeting.id}-summary.pdf`,
          toPdf(meeting, analysis, diagrams, await orgLogoPng()),
        )
        toast('success', t('ext.docs.pdfDownloaded'))
      } catch (error) {
        toast('error', t('ext.docs.pdfFailed', { error: (error as Error).message }))
      } finally {
        setPdfBusy(false)
      }
    } else {
      setDesktopBusy(true)
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'bridge-deliver-meeting',
          meetingId: meeting.id,
        })
        if (response?.ok) {
          toast('success', t('ext.docs.documentSentDesktop', { label: t('ext.summary.label') }))
        } else {
          reportDesktopError(response?.error ?? response?.reason ?? '')
        }
      } catch (error) {
        reportDesktopError((error as Error).message)
      } finally {
        setDesktopBusy(false)
      }
    }
  }


  return (
    <div className="docgen">
      <div className="doc-output-heading">{t('ext.docs.outputHeading')}</div>
      <p className="doc-output-hint">
        {t('ext.docs.outputHint', { label: meta.label })}
      </p>
      <RadioGroup
        name={`document-output-${meeting.id}`}
        label={t('ext.docs.outputType')}
        options={TYPES.map((kind) => ({ value: kind, label: DOC_META[kind].label }))}
        value={type}
        onChange={(value) => setType(value as DocType)}
      />
      {templates.length > 0 && (
        <label className="doc-template">
          <span>{t('ext.docs.customTemplate')}</span>
          <select
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
            disabled={anyRunning}
            aria-label={t('ext.docs.customTemplate')}
          >
            <option value="">{t('ext.docgen.standardTemplate')}</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {timeline.length > 0 && (
        <details className="doc-scope" open>
          <summary>
            {t('ext.docs.timelineScope')}
            <span className="doc-scope-count">{selectedTimeline.size}/{timeline.length}</span>
          </summary>
          <p className="hint">{t('ext.docs.timelineScopeHint')}</p>
          <TimelineScopeList
            timeline={timeline}
            selected={selectedTimeline}
            indeterminate={indeterminateTimeline}
            disabled={anyRunning}
            onToggle={onToggleTimeline}
          />
        </details>
      )}
      <div className="doc-output-actions">
        <div className="doc-export-control" ref={exportMenuRef}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-haspopup="menu"
            aria-expanded={exportMenuOpen}
            aria-controls={`document-export-menu-${meeting.id}`}
            disabled={anyRunning || desktopBusy || pdfBusy}
            onClick={() => setExportMenuOpen((open) => !open)}
          >
            <Download className="size-3.5 mr-1.5" />
            {t('ext.docs.exportResult')} <ChevronDown className="size-3 ml-1" />
          </Button>
          {exportMenuOpen && (
            <div
              className="doc-export-menu"
              id={`document-export-menu-${meeting.id}`}
              role="menu"
              aria-label={t('ext.docs.exportResult')}
            >
              {analysis && (
                <div
                  className="doc-export-group"
                  role="group"
                  aria-label={t('ext.docs.exportSummaryGroup')}
                >
                  <strong className="doc-export-group-title">{t('ext.docs.exportSummaryGroup')}</strong>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="doc-export-item w-full justify-start text-xs font-normal"
                    role="menuitem"
                    onClick={() => void exportSummary('markdown')}
                  >
                    <FileText className="size-3.5 mr-2 text-muted-foreground" />
                    {t('ext.docs.markdownExport')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="doc-export-item w-full justify-start text-xs font-normal"
                    role="menuitem"
                    onClick={() => void exportSummary('obsidian')}
                  >
                    <FileCode className="size-3.5 mr-2 text-purple-400" />
                    {t('ext.docs.obsidianExport')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="doc-export-item w-full justify-start text-xs font-normal"
                    role="menuitem"
                    disabled={pdfBusy}
                    onClick={() => void exportSummary('pdf')}
                  >
                    <FileDown className="size-3.5 mr-2 text-red-400" />
                    {t('ext.docs.pdfExport')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="doc-export-item w-full justify-start text-xs font-normal"
                    role="menuitem"
                    disabled={desktopBusy}
                    onClick={() => void exportSummary('desktop')}
                  >
                    <Send className="size-3.5 mr-2 text-primary" />
                    {t('ext.docs.exportSummaryDesktop')}
                  </Button>
                </div>
              )}
              <div
                className="doc-export-group"
                role="group"
                aria-label={t('ext.docs.exportDocumentGroup')}
              >
                <strong className="doc-export-group-title">{t('ext.docs.exportDocumentGroup')}</strong>
                <p>
                  {current
                    ? t('ext.docs.exportDocumentHint', { label: meta.label })
                    : t('ext.docs.exportTranscriptHint')}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="doc-export-item w-full justify-start text-xs font-normal"
                  role="menuitem"
                  onClick={() => void exportResult('markdown')}
                >
                  <FileText className="size-3.5 mr-2 text-muted-foreground" />
                  {t('ext.docs.markdownExport')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="doc-export-item w-full justify-start text-xs font-normal"
                  role="menuitem"
                  onClick={() => void exportResult('obsidian')}
                >
                  <FileCode className="size-3.5 mr-2 text-purple-400" />
                  {t('ext.docs.obsidianExport')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="doc-export-item w-full justify-start text-xs font-normal"
                  role="menuitem"
                  disabled={pdfBusy}
                  onClick={() => void exportResult('pdf')}
                >
                  <FileDown className="size-3.5 mr-2 text-red-400" />
                  {t('ext.docs.pdfExport')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="doc-export-item w-full justify-start text-xs font-normal"
                  role="menuitem"
                  disabled={desktopBusy}
                  onClick={() => void exportResult('desktop')}
                >
                  <Send className="size-3.5 mr-2 text-primary" />
                  {current
                    ? t('ext.docs.desktopExportDocument', { label: meta.label })
                    : t('ext.docs.desktopExportTranscript')}
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="doc-primary-actions">
          {analysis && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              title={t('ext.summary.reanalyzeHint')}
              onClick={() => void regenerateSummary()}
              disabled={summaryBusy}
            >
              <RefreshCw className={`size-3.5 mr-1.5 ${summaryBusy ? 'animate-spin' : ''}`} />
              {summaryBusy ? t('ext.summary.processing') : t('ext.summary.regenerate')}
            </Button>
          )}
          <Button
            variant="default"
            size="sm"
            type="button"
            onClick={() => void generate(type)}
            title={t('ext.docs.generateDocumentHint', { label: meta.label })}
            disabled={
              running ||
              (anyRunning && !active) ||
              (timeline.length > 0 && selectedTimeline.size === 0) ||
              includedEntryCount === 0
            }
          >
            <Sparkles className="size-3.5 mr-1.5" />
            {running
              ? t('ext.docs.generatingPercent', { label: meta.label, pct })
              : t('ext.docs.generateDocument', { label: meta.label })}
          </Button>
        </div>
      </div>
      {running ? (
        <div className="summary-body">
          <div
            className="doc-output-progress"
            role="progressbar"
            aria-label={t('ext.docs.generating')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="transcript-note dim">
            {t('ext.docs.progress', { label: meta.label, stage: active!.label, pct })}
          </p>
        </div>
      ) : current ? (
        <div className="doc-view">
          <div className="doc-meta dim">
            {t('ext.docs.meta', { label: meta.label, date: formatDateTime(current.generatedAt) })}
          </div>
          <pre className="doc-sheet">{current.content}</pre>
        </div>
      ) : stalled ? (
        <p className="empty-hint doc-output-stalled">{t('ext.docs.stalled', { label: meta.label })}</p>
      ) : null}
    </div>
  )
}
