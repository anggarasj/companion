import { useEffect, useRef, useState } from 'react';
import { locale, t } from '@meetcc/shared/i18n';
import {
  CHAT_PREFIX,
  clearChat,
  displayMeetingId,
  loadChat,
  watchStorage,
  type Answerability,
  type AskResult,
  type ChatMessage,
  type Meeting,
} from '@meetcc/shared';
import { useToast } from '@meetcc/ui';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Bot,
  HelpCircle,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react';

/** Keys, not text: the chips are both the label and the question sent, so both
    have to be in the reader's language. */
const SUGGESTIONS = [
  'ext.ask.suggest1',
  'ext.ask.suggest2',
  'ext.ask.suggest3',
  'ext.ask.suggest4',
] as const;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

/** The four grades are the point of Ask v2: "partial" and "inferred" are real
 *  answers, so they must not look like a failure in the UI. */
const ANSWERABILITY_LABEL: Record<Answerability, Parameters<typeof t>[0]> = {
  explicit: 'ext.ask.grade.explicit',
  partial: 'ext.ask.grade.partial',
  inferred: 'ext.ask.grade.inferred',
  not_found: 'ext.ask.grade.notFound',
};

function confidenceLabel(c: number): string {
  return c >= 0.75 ? t('ext.confidence.high') : c >= 0.45 ? t('ext.confidence.medium') : t('ext.confidence.low');
}

function ResultMeta({ result, onAsk }: { result: AskResult; onAsk: (q: string) => void }) {
  return (
    <div className="ask-meta mt-2 pt-2 border-t border-border/40 flex flex-col gap-2">
      <div className="ask-grades flex items-center gap-1.5 flex-wrap">
        <Badge variant="outline" className={`ask-grade ask-grade-${result.answerability} text-[10px] font-medium`}>
          {t(ANSWERABILITY_LABEL[result.answerability])}
        </Badge>
        {result.intent === 'advise' && (
          <Badge variant="secondary" className="ask-grade ask-grade-advise text-[10px]">
            {t('ext.ask.advise')}
          </Badge>
        )}
        <span className="ask-conf dim text-[11px] text-muted-foreground flex items-center gap-1">
          <Sparkles className="size-3" />
          Keyakinan {confidenceLabel(result.confidence)}
        </span>
      </div>

      {result.missing.length > 0 && (
        <div className="ask-missing text-xs">
          <span className="ask-meta-label font-semibold text-muted-foreground block mb-0.5">{t('ext.ask.undecided')}</span>
          <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
            {result.missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {result.evidence.length > 0 && (
        <div className="ask-evidence text-xs">
          <span className="ask-meta-label font-semibold text-muted-foreground block mb-0.5">{t('ext.ask.evidence')}</span>
          <ul className="space-y-1">
            {result.evidence.map((e, i) => (
              <li key={i} className="p-1.5 rounded bg-muted/40 border border-border/30">
                <span className="ask-ev-who font-mono text-[10px] text-primary block">
                  {e.speakers.join(', ')} · {fmtTime(e.startTime)}
                </span>
                <span className="ask-ev-text text-foreground/90">{e.preview}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.followUps.length > 0 && (
        <div className="ask-followups flex items-center gap-1.5 flex-wrap mt-1">
          {result.followUps.map((q, i) => (
            <Button
              key={i}
              variant="outline"
              size="xs"
              className="ask-chip rounded-full h-6 text-xs"
              onClick={() => onAsk(q)}
            >
              {q}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AskView({ meeting, live }: { meeting: Meeting; live: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    const reload = () => void loadChat(meeting.id).then((h) => alive && setMessages(h));
    reload();
    const stop = watchStorage(reload, [CHAT_PREFIX]);
    return () => {
      alive = false;
      stop();
    };
  }, [meeting.id]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, busy]);

  const send = async (raw: string) => {
    const question = raw.trim();
    if (!question || busy) return;
    setInput('');
    const now = new Date().toISOString();
    setMessages((m) => [...m, { role: 'user', content: question, time: now }]);
    setBusy(true);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ask', meetingId: meeting.id, question });
      if (!res?.ok) toast('error', t('ext.failed', { error: res?.error ?? t('ext.unknownError') }));
    } catch (e) {
      toast('error', t('ext.failed', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    await clearChat(meeting.id);
    setMessages([]);
    toast('info', t('ext.ask.cleared'));
  };

  const empty = messages.length === 0;

  return (
    <div className="ask flex flex-col h-full">
      <div className="subbar flex items-center justify-between p-2.5 border-b border-border/40">
        <span className="ask-hint dim text-xs text-muted-foreground flex items-center gap-1.5">
          <HelpCircle className="size-3.5 text-muted-foreground/70" />
          {t('ext.ask.hint')}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-destructive"
          onClick={clear}
          disabled={empty || busy}
        >
          <Trash2 className="size-3 mr-1" />
          {'Clear'}
        </Button>
      </div>

      <div className="ask-scroll flex-1 overflow-y-auto p-4" ref={scroller}>
        {empty && !busy ? (
          <div className="ask-empty flex flex-col items-center justify-center p-8 text-center gap-3">
            <div className="empty-glyph p-3 rounded-full bg-primary/10 text-primary border border-primary/20">
              <Bot className="size-8" />
            </div>
            <p className="font-semibold text-sm text-foreground">{t('ext.ask.empty')}</p>
            <p className="empty-hint text-xs text-muted-foreground max-w-sm">
              {t('ext.ask.emptyHint', { id: displayMeetingId(meeting.id) })}
            </p>
            <div className="ask-suggest flex items-center justify-center gap-1.5 flex-wrap max-w-md mt-2">
              {SUGGESTIONS.map((key) => (
                <Button
                  key={key}
                  variant="outline"
                  size="xs"
                  className="ask-chip rounded-full h-7 text-xs"
                  onClick={() => void send(t(key))}
                  disabled={busy}
                >
                  {t(key)}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="ask-thread space-y-4 max-w-2xl mx-auto">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`bubble bubble-${m.role} p-3.5 rounded-xl border text-xs ${m.role === 'user' ? 'bg-primary/10 border-primary/25 ml-auto max-w-[85%]' : 'bg-card border-border/60 mr-auto max-w-[95%] shadow-xs'}`}
              >
                <div className="bubble-text leading-relaxed whitespace-pre-wrap">{m.content}</div>
                {m.result && <ResultMeta result={m.result} onAsk={(q) => void send(q)} />}
                <time className="bubble-time font-mono text-[10px] text-muted-foreground block mt-1.5 text-right">{fmtTime(m.time)}</time>
              </div>
            ))}
            {busy && (
              <div className="bubble bubble-assistant p-3 rounded-xl border border-border/60 bg-card mr-auto shadow-xs" aria-live="polite">
                <div className="typing flex items-center gap-1.5" aria-label="Menjawab">
                  <span className="size-2 rounded-full bg-primary animate-bounce" />
                  <span className="size-2 rounded-full bg-primary animate-bounce [animation-delay:0.2s]" />
                  <span className="size-2 rounded-full bg-primary animate-bounce [animation-delay:0.4s]" />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <form
        className="ask-composer p-3 border-t border-border/50 bg-background flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <Textarea
          className="ask-input min-h-[38px] max-h-32 text-xs py-2 resize-none"
          value={input}
          rows={1}
          placeholder={live ? t('ext.ask.placeholderLive') : t('ext.ask.placeholder')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          aria-label={t('ext.ask.question')}
        />
        <Button variant="default" size="sm" type="submit" disabled={busy || !input.trim()}>
          <Send className="size-3.5 mr-1" />
          {busy ? '…' : t('ext.ask.send')}
        </Button>
      </form>
    </div>
  );
}
