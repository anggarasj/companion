import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { locale, t, formatDateTime } from '@meetcc/shared/i18n'
import {
  CLEAN_PREFIX,
  cleanChanges,
  effectiveClean,
  loadClean,
  saveClean,
  watchStorage,
  type CleanRecord,
  type Entry,
  type Meeting,
} from '@meetcc/shared'
import { useToast } from '@meetcc/ui'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Segmented } from './Segmented'
import { liveActions, speakerStats } from '@meetcc/meeting'
import { listHighlights } from '../lib/db'
import {
  Copy,
  Download,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react'

// Teams avatar URLs need the Teams session cookies; from the extension page
// they 401 into a broken image, so fall back to the initial on load error.
function Avatar({ src, name }: { src?: string; name: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  if (!src || broken) {
    return (
      <div className="avatar avatar-ph flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-xs border border-primary/20">
        {(name[0] || '?').toUpperCase()}
      </div>
    )
  }
  return (
    <img
      className="avatar size-7 shrink-0 rounded-full object-cover border border-border/40"
      src={src}
      alt=""
      onError={() => setBroken(true)}
    />
  )
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function toTxt(entries: Entry[]): string {
  return entries.map((e) => `[${e.time}] ${e.speaker}: ${e.text}`).join('\n')
}

interface Props {
  meeting: Meeting
  live: boolean
  onClear: () => void
  selectedEntries: Set<number>
  onToggleEntry: (index: number, checked: boolean) => void
}

/** Keys, not text: resolved at render time so the labels follow the language. */
const HIGHLIGHT_LABEL: Record<string, Parameters<typeof t>[0]> = {
  decision: 'ext.kind.decision',
  action: 'ext.kind.action',
  deadline: 'ext.kind.deadline',
  risk: 'ext.kind.risk',
}

export function Transcript({
  meeting,
  live,
  onClear,
  selectedEntries,
  onToggleEntry,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const toast = useToast()

  // cleanup state comes from storage (a persisted record), so "Merapikan…"
  // survives tab switches / remounts and the button can't double-fire.
  const [record, setRecord] = useState<CleanRecord | null>(null)
  const [view, setView] = useState<'raw' | 'clean'>('raw')
  const [now, setNow] = useState(() => Date.now())
  // P2.2 — moments the live pass flagged (decision / action / deadline / risk)
  const [highlights, setHighlights] = useState<
    { id: number; seq: number; kind: string; text: string }[]
  >([])

  const reload = useCallback(() => {
    void loadClean(meeting.id).then((r) => {
      setRecord(r)
      setView(r?.status === 'done' && r.entries.length ? 'clean' : 'raw')
    })
  }, [meeting.id])

  useEffect(() => {
    reload()
    return watchStorage(reload, [CLEAN_PREFIX]) // background writes clean:<id>
  }, [reload])

  useEffect(() => {
    let alive = true
    void listHighlights(meeting.id)
      .then((h) => alive && setHighlights(h))
      .catch(() => undefined) // index not built yet: the transcript still shows
    return () => {
      alive = false
    }
  }, [meeting.id, meeting.entries.length])

  // tick so a crashed run (no storage updates) is detected as stalled
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 8000)
    return () => clearInterval(t)
  }, [])

  // P2.2 follow-on: the flagged "action" lines, with whatever PIC and deadline
  // the sentence itself gave — something to raise before everyone leaves.
  const todo = useMemo(
    () => (live ? liveActions(highlights, meeting.entries) : []),
    [live, highlights, meeting.entries],
  )

  const bySeq = useMemo(
    () => new Map(highlights.map((h) => [h.seq, h.kind])),
    [highlights],
  )

  // §26 provenance: what the AI changed, and whether the user kept the original
  const changes = useMemo(() => cleanChanges(meeting.entries, record), [meeting.entries, record])
  const changedAt = useMemo(() => new Map(changes.map((c) => [c.index, c])), [changes])

  // toggling a correction rewrites the stored record, so every downstream
  // reader (summary, Ask, docs, index) picks the decision up on its next read
  const keepOriginal = async (index: number, keep: boolean) => {
    if (record?.status !== 'done') return
    const kept = new Set(record.kept ?? [])
    if (keep) kept.add(index)
    else kept.delete(index)
    const next = { ...record, kept: [...kept].sort((a, b) => a - b) }
    setRecord(next)
    await saveClean(meeting.id, next)
  }

  const cleaned = record?.status === 'done' ? record.entries : null
  const processing = record?.status === 'processing'
  const done = processing ? (record.done ?? 0) : 0
  const total = processing ? (record.total ?? 0) : 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  // no progress update for 60s (or a malformed/old record with no updatedAt)
  // = the run died -> treat as stalled so the user can resume or restart
  const age = processing ? now - Date.parse(record.updatedAt) : 0
  const stalled = processing && !(age < 60_000)
  const running = processing && !stalled
  const entries =
    view === 'clean' && cleaned ? effectiveClean(meeting.entries, record) : meeting.entries

  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [entries])

  // who actually talked — derived from the lines already on screen, no query
  const talk = useMemo(() => speakerStats(entries), [entries])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  const cleanUp = async (fromScratch = false) => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'clean-transcript',
        meetingId: meeting.id,
        fromScratch,
      })
      if (res?.ok) toast('success', t('ext.transcript.cleaned', { count: res.changed }))
      else toast('error', t('ext.failed', { error: res?.error ?? t('ext.unknownError') }))
    } catch (e) {
      toast('error', t('ext.failed', { error: (e as Error).message }))
    }
    reload()
  }

  return (
    <>
      <div className="subbar flex items-center gap-1.5 flex-wrap p-2 border-b border-border/40">
        {cleaned && (
          <Segmented
            ariaLabel={t('ext.transcript.versions')}
            role="tablist"
            options={[
              { value: 'raw', label: 'Asli' },
              { value: 'clean', label: 'Rapi' },
            ]}
            value={view}
            onChange={(value) => setView(value as typeof view)}
          />
        )}
        <Button
          variant="outline"
          size="xs"
          onClick={async () => {
            await navigator.clipboard.writeText(toTxt(entries))
            toast('success', t('ext.transcript.copied'))
          }}
        >
          <Copy className="size-3 mr-1" />
          {t('ext.version.copy')}
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([toTxt(entries)], { type: 'text/plain' }),
            )
            const a = document.createElement('a')
            a.href = url
            a.download = `${meeting.id}${view === 'clean' ? '-rapi' : ''}.txt`
            a.click()
            URL.revokeObjectURL(url)
          }}
        >
          <Download className="size-3 mr-1" />
          {'TXT'}
        </Button>
        <span className="spacer flex-1" />
        {(cleaned || stalled) && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void cleanUp(true)}
            disabled={running || live}
            title={t('ext.transcript.redoHint')}
          >
            <RotateCcw className="size-3 mr-1" />
            {'Dari awal'}
          </Button>
        )}
        <Button
          variant={running ? 'default' : 'default'}
          size="xs"
          onClick={() => void cleanUp(false)}
          disabled={running || live || !meeting.entries.length}
          title={
            live
              ? t('ext.transcript.waitForEnd')
              : t('ext.transcript.cleanHint')
          }
        >
          {running ? (
            <>
              <Sparkles className="size-3 mr-1 animate-spin" />
              {`Merapikan… ${pct}%`}
            </>
          ) : stalled ? (
            <>
              <Play className="size-3 mr-1" />
              {`Lanjutkan ${pct}%`}
            </>
          ) : cleaned ? (
            <>
              <Sparkles className="size-3 mr-1 text-primary" />
              {t('ext.transcript.recleanBtn')}
            </>
          ) : (
            <>
              <Sparkles className="size-3 mr-1 text-primary" />
              {'Rapikan'}
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={onClear}
        >
          <Trash2 className="size-3 mr-1" />
          {'Clear'}
        </Button>
      </div>

      {meeting.entries.length > 0 && (
        <div className="transcript-message-count px-3 py-1.5 text-xs text-muted-foreground bg-muted/20 border-b border-border/30">
          {t('ext.transcript.selectedEntryCount', {
            count: selectedEntries.size,
            total: meeting.entries.length,
          })}
        </div>
      )}
      {highlights.length > 0 && view === 'raw' && (
        <div className="hl-strip p-2 border-b border-border/30 flex flex-wrap gap-1 items-center">
          <span className="section-label text-[11px] font-semibold uppercase text-muted-foreground mr-1">{t('ext.transcript.highlights')}</span>
          {highlights.slice(-8).map((h) => (
            <Button
              key={h.id}
              variant="outline"
              size="xs"
              className={`hl-chip hl-${h.kind} text-xs h-6 px-2`}
              title={h.text}
              onClick={() => {
                const el = ref.current?.querySelectorAll('.entry')[h.seq]
                el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }}
            >
              {HIGHLIGHT_LABEL[h.kind] ? t(HIGHLIGHT_LABEL[h.kind]) : h.kind}: {h.text.slice(0, 48)}
            </Button>
          ))}
        </div>
      )}

      {talk.length > 1 && (
        <div className="talk-strip p-2 border-b border-border/30 flex flex-wrap gap-2 items-center">
          <span className="section-label text-[11px] font-semibold uppercase text-muted-foreground">{t('ext.transcript.speakingShare')}</span>
          {talk.slice(0, 6).map((t) => (
            <span
              key={t.speaker}
              className="talk-item inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              title={`${t.turns} giliran · ${t.words} kata`}
            >
              <span className="talk-name font-medium text-foreground">{t.speaker}</span>
              <span className="talk-bar h-1.5 w-12 rounded-full bg-muted overflow-hidden">
                <span className="talk-fill block h-full bg-primary" style={{ width: `${Math.round(t.share * 100)}%` }} />
              </span>
              <span className="talk-pct text-[11px] font-mono">{Math.round(t.share * 100)}%</span>
            </span>
          ))}
        </div>
      )}

      {todo.length > 0 && view === 'raw' && (
        <div className="todo-strip p-2.5 border-b border-border/30 bg-muted/20">
          <span className="section-label text-[11px] font-semibold uppercase text-muted-foreground">{t('ext.transcript.detectedActions')}</span>
          <ul className="todo-list flex flex-col gap-1 mt-1">
            {todo.slice(-5).map((row) => (
              <li key={row.seq} className="text-xs flex items-center justify-between gap-2">
                <span className="todo-task font-medium text-foreground">{row.task}</span>
                <span className="dim text-muted-foreground text-[11px]">
                  {row.owner || t('ext.transcript.noOwner')}
                  {row.due ? ` · ${row.due}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <span className="dim todo-note text-[11px] text-muted-foreground/70 block mt-1">
            {t('ext.transcript.keywordGuess')}
          </span>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="empty-state p-8 text-center text-muted-foreground">
          <p className="empty-hint text-xs">{t('ext.transcript.waitingForSpeech')}</p>
        </div>
      ) : (
        <div className="transcript p-3 flex flex-col gap-3 overflow-y-auto" ref={ref} onScroll={onScroll}>
          {running && (
            <p className="transcript-note dim text-xs text-muted-foreground bg-primary/5 border border-primary/20 p-2 rounded">
              AI merapikan transcript… {done}/{total} baris ({pct}%). Hasil muncul otomatis.
            </p>
          )}
          {stalled && (
            <p className="transcript-note dim text-xs text-warning bg-warning/5 border border-warning/20 p-2 rounded">
              Proses terhenti di {pct}% (mungkin tab lama ditutup). Klik “Lanjutkan” untuk melanjutkan.
            </p>
          )}
          {view === 'clean' && cleaned && record?.status === 'done' && (
            <p className="transcript-note dim text-xs text-muted-foreground">
              {t('ext.transcript.cleanNote', {
                count: record.changed,
                date: formatDateTime(record.generatedAt),
              })}
            </p>
          )}
          {cleaned && meeting.entries.length > cleaned.length && (
            <p className="transcript-note dim text-xs text-muted-foreground">
              {t('ext.transcript.newSinceFull', {
                count: meeting.entries.length - cleaned.length,
                button: t('ext.transcript.recleanBtn'),
              })}
            </p>
          )}
          {entries.map((e, i) => {
            const isTail = live && view === 'raw' && i === entries.length - 1
            const flag = view === 'raw' ? bySeq.get(i) : undefined
            return (
              <article
                className={`entry flex gap-2.5 p-2 rounded-lg transition-colors hover:bg-muted/30 ${flag ? 'entry-flagged border-l-2 border-primary pl-2' : ''} ${selectedEntries.has(i) ? '' : 'entry-excluded opacity-50'}`}
                key={`${e.time}-${i}`}
              >
                <Avatar src={e.avatar} name={e.speaker} />
                <div className="entry-body flex-1 min-w-0">
                  <div className="entry-head flex items-center gap-2">
                    <span className="speaker font-semibold text-xs text-foreground">{e.speaker}</span>
                    <time className="stamp text-[11px] font-mono text-muted-foreground">{fmtTime(e.time)}</time>
                    {flag && (
                      <Badge variant="outline" className={`hl-tag hl-${flag} text-[10px] px-1 py-0`}>
                        {HIGHLIGHT_LABEL[flag] ? t(HIGHLIGHT_LABEL[flag]) : flag}
                      </Badge>
                    )}
                    <span className="spacer flex-1" />
                    <input
                      type="checkbox"
                      className="entry-include-toggle size-3.5 rounded border-border/60 text-primary cursor-pointer"
                      aria-label={t('ext.transcript.includeEntryInDoc', {
                        speaker: e.speaker,
                        time: fmtTime(e.time),
                      })}
                      checked={selectedEntries.has(i)}
                      onChange={(event) => onToggleEntry(i, event.target.checked)}
                    />
                  </div>
                  <p className="text text-xs leading-relaxed text-foreground/90 mt-1 break-words">
                    {e.text}
                    {isTail && <span className="caret inline-block size-1.5 ml-1 rounded-full bg-primary animate-pulse" />}
                  </p>
                  {view === 'clean' && changedAt.has(i) && (
                    <div className="clean-diff mt-1.5 p-1.5 rounded bg-muted/40 border border-border/40 text-xs">
                      <span className="clean-raw line-through text-muted-foreground mr-2" title={t('ext.transcript.captured')}>
                        {changedAt.get(i)!.raw}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="clean-toggle text-[11px] h-5 px-1.5"
                        onClick={() => void keepOriginal(i, !changedAt.get(i)!.kept)}
                      >
                        {changedAt.get(i)!.kept ? t('ext.transcript.useAi') : t('ext.transcript.useOriginal')}
                      </Button>
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </>
  )
}
