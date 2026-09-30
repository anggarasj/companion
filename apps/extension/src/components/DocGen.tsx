import { useCallback, useEffect, useRef, useState } from 'react'
import { t, formatDateTime } from '@meetcc/shared/i18n'
import { DOC_META } from '@meetcc/ai'
import { toObsidianDocument } from '@meetcc/exporters/obsidian'
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
import { Button, RadioGroup, useToast } from '@meetcc/ui'

const TYPES: DocType[] = ['notulen', 'brd', 'prd', 'recap']
type DocumentExport = 'markdown' | 'obsidian' | 'pdf' | 'desktop'

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export function DocumentOutputs({ meeting, analysis }: { meeting: Meeting; analysis: Analysis | null }) {
  const [type, setType] = useState<DocType>('notulen')
  const [docs, setDocs] = useState<MeetingDocs>({})
  const [prog, setProg] = useState<DocProgressRecord | null>(null)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [desktopBusy, setDesktopBusy] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const toast = useToast()

  // P2.1 — an optional user template steers the document's structure.
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([])
  const [templateId, setTemplateId] = useState('')
  const [selectedTimeline, setSelectedTimeline] = useState<Set<number>>(
    () => new Set(analysis?.timeline.map((_, index) => index) ?? []),
  )

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
  const timeline = analysis?.timeline ?? []


  const generate = async (
    docType: DocType,
    announce = true,
  ): Promise<StoredDoc | null> => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'generate-doc',
        meetingId: meeting.id,
        docType,
        templateId: templateId || undefined,
        ...(timeline.length ? { timelineIndices: [...selectedTimeline].sort((a, b) => a - b) } : {}),
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


  return (
    <div className="docgen">
      <div className="doc-output-heading">{t('ext.docs.outputHeading')}</div>
      <p className="doc-output-hint">{t('ext.docs.outputHint')}</p>
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
          <div className="doc-scope-list">
            {timeline.map((item, index) => (
              <label key={`${item.time}-${index}`}>
                <input
                  type="checkbox"
                  checked={selectedTimeline.has(index)}
                  disabled={anyRunning}
                  onChange={(event) => {
                    setSelectedTimeline((selected) => {
                      const next = new Set(selected)
                      if (event.target.checked) next.add(index)
                      else next.delete(index)
                      return next
                    })
                  }}
                />
                <span>
                  <strong>{item.time || '—'}</strong> {item.topic}
                </span>
              </label>
            ))}
          </div>
        </details>
      )}
      <div className="doc-output-actions">
        <div className="doc-export-control" ref={exportMenuRef}>
          <Button
            type="button"
            aria-haspopup="menu"
            aria-expanded={exportMenuOpen}
            aria-controls={`document-export-menu-${meeting.id}`}
            disabled={anyRunning || desktopBusy}
            onClick={() => setExportMenuOpen((open) => !open)}
          >
            {t('ext.docs.exportResult')} <span aria-hidden="true">▾</span>
          </Button>
          {exportMenuOpen && (
            <div
              className="doc-export-menu"
              id={`document-export-menu-${meeting.id}`}
              role="menu"
              aria-label={t('ext.docs.exportResult')}
            >
              <p>
                {current
                  ? t('ext.docs.exportDocumentHint', { label: meta.label })
                  : t('ext.docs.exportTranscriptHint')}
              </p>
              <Button
                type="button"
                className="doc-export-item"
                role="menuitem"
                onClick={() => void exportResult('markdown')}
              >
                {t('ext.docs.markdownExport')}
              </Button>
              <Button
                type="button"
                className="doc-export-item"
                role="menuitem"
                onClick={() => void exportResult('obsidian')}
              >
                {t('ext.docs.obsidianExport')}
              </Button>
              <Button
                type="button"
                className="doc-export-item"
                role="menuitem"
                disabled={pdfBusy}
                onClick={() => void exportResult('pdf')}
              >
                {t('ext.docs.pdfExport')}
              </Button>
              <Button
                type="button"
                className="doc-export-item"
                role="menuitem"
                onClick={() => void exportResult('desktop')}
              >
                {current
                  ? t('ext.docs.desktopExportDocument', { label: meta.label })
                  : t('ext.docs.desktopExportTranscript')}
              </Button>
            </div>
          )}
        </div>
        <Button
          variant="primary"
          type="button"
          onClick={() => void generate(type)}
          disabled={
            running ||
            (anyRunning && !active) ||
            (timeline.length > 0 && selectedTimeline.size === 0)
          }
        >
          {running
            ? t('ext.docs.generatingPercent', { label: meta.label, pct })
            : t('ext.docs.generateDocument')}
        </Button>
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
