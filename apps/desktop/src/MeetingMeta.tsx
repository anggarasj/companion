// What a delivered meeting knows about itself.
//
// The note file has carried `participants`, `platform`, `startedAt` and a
// transcript sidecar path since the bridge first wrote one; the editor simply
// never showed any of it, so the inbox could say "3 participants" and opening
// the note told you nothing about who they were.
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { formatDateTime, t } from '@meetcc/shared/i18n'
import { copyText } from './clipboard'
import type { Vault, VaultNote } from '@meetcc/vault'
import { askMeeting, createClient, resolveConfig, validateSettings, MAX_HISTORY_TURNS } from '@meetcc/ai'
import type { ChatMessage, Meeting } from '@meetcc/shared/types'
import { loadAiSettings } from './aiSettings'
import { Copy, LoaderCircle, ScrollText, SendHorizontal, Video } from 'lucide-react'
import { useToast } from './toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The id Chromium loads the shipped extension under.
 *
 * Derived from the `key` pinned in apps/extension/public/manifest.json, which
 * is why it is a constant and not a guess — `extensionIdFromKey` in
 * scripts/nativeHost.mjs computes it, and MeetingMeta.test.ts checks this
 * string still matches the manifest.
 */
export const EXTENSION_ID = 'neeapigpheabagekbdfjdekgdicfckpn'

/** `room#2026-09-04T10:00` → `room`, which is the extension's meeting id. */
export function roomIdOf(sessionKey: string): string {
  return sessionKey.split('#')[0] ?? ''
}

export function dashboardUrl(sessionKey: string): string {
  return `chrome-extension://${EXTENSION_ID}/index.html?meeting=${encodeURIComponent(roomIdOf(sessionKey))}`
}

export interface TranscriptLine {
  speaker: string
  text: string
  time: string
}

/** One JSONL line per caption. A malformed line is skipped, not fatal. */
export function parseTranscript(jsonl: string): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as Partial<TranscriptLine>
      if (typeof row.text === 'string') {
        out.push({ speaker: row.speaker ?? '', text: row.text, time: row.time ?? '' })
      }
    } catch {
      /* a truncated final line is normal for an append-only file */
    }
  }
  return out
}

/** A delivered note and its transcript as the Meeting the AI pipeline reads. */
export function meetingOf(note: VaultNote, lines: TranscriptLine[]): Meeting {
  const startedAt = note.startedAt || lines[0]?.time || note.updatedAt
  return {
    id: note.sessionKey,
    meta: { id: note.sessionKey, startedAt, lastSeenAt: lines[lines.length - 1]?.time || startedAt },
    entries: lines,
  }
}

/** Read a delivered note's transcript sidecar; empty when it has none. */
export async function readTranscript(note: VaultNote, vault: Vault): Promise<TranscriptLine[]> {
  if (!note.transcript) return []
  return parseTranscript(await vault.io.readFile(vault.io.join(vault.io.root, note.transcript)))
}

const PLATFORM_LABELS: Record<string, string> = {
  'google-meet': 'Google Meet',
  'microsoft-teams': 'Microsoft Teams',
  teams: 'Microsoft Teams',
  zoom: 'Zoom',
  import: 'Import',
}

export function MeetingMeta({ note, vault }: { note: VaultNote; vault: Vault | null }) {
  const toast = useToast()
  const [lines, setLines] = useState<TranscriptLine[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const currentNoteId = useRef(note.id)
  const transcriptRequest = useRef(0)
  const askRequest = useRef(0)

  // Invalidate in render so a completion from the previous note cannot land
  // in the interval before the reset effect runs.
  if (currentNoteId.current !== note.id) {
    currentNoteId.current = note.id
    transcriptRequest.current += 1
    askRequest.current += 1
  }

  const participants = note.participants ?? []
  const url = dashboardUrl(note.sessionKey)

  useLayoutEffect(() => {
    transcriptRequest.current += 1
    askRequest.current += 1
    setLines(null)
    setOpen(false)
    setBusy(false)
    setFailed(null)
    setQuestion('')
    setHistory([])
    setAsking(false)
    setAskError(null)
  }, [note.id])

  // Read on demand, not with the note: a long meeting's sidecar is large and
  // opening a note must not pay for a transcript nobody asked to see.
  const toggle = async (): Promise<void> => {
    if (open) return setOpen(false)
    setOpen(true)
    if (lines || !note.transcript || !vault) return
    const requestedNoteId = note.id
    const requestId = ++transcriptRequest.current
    const isCurrent = () =>
      currentNoteId.current === requestedNoteId && transcriptRequest.current === requestId
    setBusy(true)
    setFailed(null)
    try {
      const read = await readTranscript(note, vault)
      if (isCurrent()) setLines(read)
    } catch (e) {
      if (isCurrent()) setFailed(String(e))
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }

  // The async Clipboard API is not reliably available in this window, so
  // `copyText` falls back to a selection-based copy that needs no permission.
  // Either way the outcome is reported: a copy that did not happen used to
  // look exactly like not having clicked.
  const copy = (): void => {
    void copyText(url).then((ok) =>
      ok
        ? toast('success', t('desktop.toast.linkCopied'))
        : toast('error', t('desktop.toast.copyFailed')),
    )
  }
  const ask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const prompt = question.trim()
    if (!prompt || !lines?.length || asking) return
    const requestedNoteId = note.id
    const requestId = ++askRequest.current
    const isCurrent = () =>
      currentNoteId.current === requestedNoteId && askRequest.current === requestId
    setAsking(true)
    setAskError(null)
    try {
      const settings = await loadAiSettings()
      if (!isCurrent()) return
      const problem = validateSettings(settings)
      if (problem) throw new Error(problem)
      const meeting = meetingOf(note, lines)
      const result = await askMeeting(
        createClient(resolveConfig(settings)),
        meeting,
        null,
        history,
        prompt,
      )
      if (isCurrent()) {
        const time = new Date().toISOString()
        const nextHistory: ChatMessage[] = [
          ...history,
          { role: 'user', content: prompt, time },
          { role: 'assistant', content: result.answer, time, result },
        ]
        setHistory(nextHistory.slice(-MAX_HISTORY_TURNS))
        setQuestion('')
      }
    } catch (e) {
      if (isCurrent()) setAskError((e as Error).message)
    } finally {
      if (isCurrent()) setAsking(false)
    }
  }


  let latestAnswer: ChatMessage | undefined
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].result) {
      latestAnswer = history[index]
      break
    }
  }

  const hint = 'my-1 text-xs text-muted-foreground'

  return (
    <section className="mb-3.5 rounded-xl border bg-sunken px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-widest text-primary">
          <Video className="size-3.5" aria-hidden="true" />
          {PLATFORM_LABELS[note.platform] ?? note.platform}
        </span>
        {note.startedAt && <span className="text-xs text-muted-foreground">{formatDateTime(note.startedAt)}</span>}
        {note.transcript && (
          <Button type="button" variant="link" size="xs" className="ml-auto" onClick={() => void toggle()}>
            <ScrollText />
            {open ? t('desktop.meeting.hideTranscript') : t('desktop.meeting.showTranscript')}
          </Button>
        )}
      </div>

      {participants.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[9.5px] font-semibold uppercase leading-none tracking-widest text-muted-foreground">{t('desktop.meeting.participants')}</span>
          {participants.map((p) => (
            <span key={p} className="rounded-full border bg-muted px-[7px] py-0.5 text-xs">
              {p}
            </span>
          ))}
        </div>
      )}

      {/* Not an "open in browser" button: chrome-extension:// is not a scheme
          the OS can launch, and the extension runs in a dedicated profile that
          the default browser is not. Copying is the only form of this that
          actually works, so the field says what it is. */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9.5px] font-semibold uppercase leading-none tracking-widest text-muted-foreground">{t('desktop.meeting.openInExtension')}</span>
        <Input className="h-[34px] min-w-0 flex-1 font-mono text-[11px]" readOnly value={url} onFocus={(e) => e.target.select()} />
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          <Copy />
          {t('desktop.meeting.copyLink')}
        </Button>
      </div>

      {open && (
        <div className="mt-2.5 max-h-[260px] overflow-y-auto border-t pt-2.5">
          {busy && <p className={hint}>{t('desktop.meeting.loadingTranscript')}</p>}
          {failed && <p className={hint}>{failed}</p>}
          {lines?.length === 0 && <p className={hint}>{t('desktop.meeting.emptyTranscript')}</p>}
          {lines?.map((l, i) => (
            <p key={i} className="mb-1 mt-0 grid grid-cols-[42px_110px_1fr] gap-2 text-[12.5px] leading-normal">
              <span className="font-mono text-[10px] leading-[1.7] text-muted-foreground">{l.time ? l.time.slice(11, 16) : ''}</span>
              <span className="truncate text-primary">{l.speaker}</span>
              <span>{l.text}</span>
            </p>
          ))}
          {!!lines?.length && (
            <div className="mt-3.5 border-t pt-3">
              <form onSubmit={(event) => void ask(event)}>
                <label className="mb-1.5 block text-xs text-muted-foreground" htmlFor={`meeting-question-${note.id}`}>
                  {t('desktop.meeting.askQuestion')}
                </label>
                <div className="flex gap-2">
                  <Input
                    className="min-w-0 flex-1"
                    id={`meeting-question-${note.id}`}
                    value={question}
                    placeholder={t('desktop.meeting.askPlaceholder')}
                    onChange={(event) => setQuestion(event.target.value)}
                    disabled={asking}
                  />
                  <Button type="submit" size="sm" className="h-9" disabled={asking || !question.trim()}>
                    {asking ? <LoaderCircle className="animate-spin" /> : <SendHorizontal />}
                    {asking ? t('desktop.meeting.asking') : t('desktop.meeting.ask')}
                  </Button>
                </div>
              </form>
              {askError && <p className="text-xs text-destructive" role="alert">{askError}</p>}
              {history.map((message, index) => (
                <div key={`${message.time}-${index}`} className={cn('mt-2.5 text-xs', message.role === 'user' && 'text-muted-foreground')}>
                  <p className="m-0">{message.content}</p>
                </div>
              ))}
              {latestAnswer?.result?.evidence.slice(0, 4).map((evidence, sourceIndex) => (
                <p key={`${evidence.startTime}-${sourceIndex}`} className="mb-0 mt-[5px] text-[11px] text-muted-foreground">
                  {evidence.startTime.slice(11, 16)} · {evidence.speakers.join(', ')} — {evidence.preview}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
