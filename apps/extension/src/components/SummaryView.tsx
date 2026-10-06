import { useEffect, useMemo, useState } from 'react';
import { locale, t } from '@meetcc/shared/i18n';
import type { Analysis, AnalysisRecord, Meeting, MiniContext } from '@meetcc/shared';
import {
  saveContext,
  getContext,
  getMeetingTags,
  saveMeetingTags,
  getMiniContexts,
  watchStorage,
  MINI_CONTEXTS_KEY,
  CONTEXT_PREFIX,
  MEETING_TAGS_PREFIX,
} from '@meetcc/shared';
import { db } from '../lib/db';
import { datedCount, toChecklist, toIcs } from '@meetcc/exporters/tasks';
import { STALE_PROCESSING_MS } from '@meetcc/meeting';
import { useToast } from '@meetcc/ui';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  AlertTriangle,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  FileText,
  HelpCircle,
  ListTodo,
  MessageSquare,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: typeof FileText;
  children: React.ReactNode;
}) {
  return (
    <section className="sum-section mb-6">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground mb-3 pb-1 border-b border-border/40">
        {Icon && <Icon className="size-4 text-primary shrink-0" />}
        <span>{title}</span>
      </h3>
      {children}
    </section>
  );
}

const List = ({ items }: { items: string[] }) =>
  items.length ? (
    <ul className="list-disc list-inside space-y-1 text-xs text-foreground/90 leading-relaxed">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  ) : (
    <p className="dim text-xs text-muted-foreground">—</p>
  );

function ActionItemsToolbar({ meeting, analysis }: { meeting: Meeting; analysis: Analysis }) {
  const toast = useToast();
  const dated = datedCount(analysis);
  return (
    <div className="task-export flex items-center gap-2 mb-2">
      <Button
        variant="outline"
        size="xs"
        onClick={async () => {
          await navigator.clipboard.writeText(toChecklist(analysis));
          toast('success', t('ext.summary.checklistCopied'));
        }}
      >
        <Copy className="size-3 mr-1" />
        {'Copy checklist'}
      </Button>
      <Button
        variant="outline"
        size="xs"
        disabled={!dated}
        title={dated ? '' : t('ext.summary.noDatedActions')}
        onClick={() => {
          downloadBlob(`${meeting.id}-tasks.ics`, new Blob([toIcs(meeting, analysis)], { type: 'text/calendar' }));
          toast('success', t('ext.summary.icsDownloaded', { count: dated }));
        }}
      >
        <Calendar className="size-3 mr-1" />
        {t('ext.data.calendar')}
      </Button>
    </div>
  );
}

function Result({ meeting, analysis }: { meeting: Meeting; analysis: Analysis }) {
  return (
    <>
      <div className="summary-body">
        <Section title="Executive Summary" icon={FileText}>
          <p className="text-xs leading-relaxed text-foreground/90">{analysis.executiveSummary}</p>
        </Section>
        <Section title={t('ext.summary.section.timeline')} icon={Clock}>
          {analysis.timeline.length ? (
            <ol className="timeline space-y-2">
              {analysis.timeline.map((item, i) => (
                <li key={i} className="flex items-start gap-2.5 text-xs">
                  <span className="tl-time font-mono text-[11px] text-muted-foreground shrink-0">{item.time || '—'}</span>
                  <span className="text-foreground/90">{item.topic}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="dim text-xs text-muted-foreground">—</p>
          )}
        </Section>
        <Section title="Key Discussion" icon={MessageSquare}>
          <List items={analysis.keyDiscussions} />
        </Section>
        <Section title="Decisions" icon={CheckCircle2}>
          {analysis.decisions.length ? (
            <ul className="decisions space-y-2.5">
              {analysis.decisions.map((d, i) => (
                <li key={i} className="p-2.5 rounded-lg border border-border/50 bg-muted/20 text-xs">
                  <div className="decision-what font-medium text-foreground flex items-center gap-2 flex-wrap">
                    {d.what}
                    {d.topic && <Badge variant="outline" className="topic-tag text-[10px]">{d.topic}</Badge>}
                  </div>
                  {d.why && <div className="decision-why text-muted-foreground mt-1">Alasan: {d.why}</div>}
                  {d.rejected.length > 0 && (
                    <div className="decision-rejected text-destructive/80 mt-1">Ditolak: {d.rejected.join('; ')}</div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="dim text-xs text-muted-foreground">—</p>
          )}
        </Section>
        <Section title="Action Items" icon={ListTodo}>
          {analysis.actionItems.length ? (
            <>
              <ActionItemsToolbar meeting={meeting} analysis={analysis} />
              <table className="ai-table w-full text-xs border border-border/40 rounded-lg overflow-hidden">
                <thead className="bg-muted/40 text-muted-foreground text-left">
                  <tr>
                    <th className="p-2 font-semibold">Task</th>
                    <th className="p-2 font-semibold">Owner</th>
                    <th className="p-2 font-semibold">Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {analysis.actionItems.map((a, i) => (
                    <tr key={i} className="hover:bg-muted/20 transition-colors">
                      <td className="p-2 text-foreground font-medium">{a.task}</td>
                      <td className="p-2 text-muted-foreground">{a.owner || '—'}</td>
                      <td className="p-2 text-muted-foreground">{a.due || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="dim text-xs text-muted-foreground">—</p>
          )}
        </Section>
        <Section title="Risks" icon={AlertTriangle}>
          <List items={analysis.risks} />
        </Section>
        <Section title="Open Questions" icon={HelpCircle}>
          <List items={analysis.openQuestions} />
        </Section>
        <Section title="Next Steps" icon={Check}>
          <List items={analysis.nextSteps} />
        </Section>
        <p className="dim generated-note text-[11px] text-muted-foreground/70 mt-6 pt-3 border-t border-border/30">
          Generated by AI — verifikasi keputusan penting terhadap transcript {meeting.id}.
        </p>
      </div>
    </>
  );
}

function appendContextTagsToMap(map: Map<string, MiniContext[]>, c: MiniContext): void {
  for (let j = 0; j < c.tags.length; j++) {
    const tg = c.tags[j].toLowerCase();
    let list = map.get(tg);
    if (!list) {
      list = [];
      map.set(tg, list);
    }
    list.push(c);
  }
}

function buildTagToContextsMap(contexts: MiniContext[]): Map<string, MiniContext[]> {
  const map = new Map<string, MiniContext[]>();
  for (let i = 0; i < contexts.length; i++) {
    appendContextTagsToMap(map, contexts[i]);
  }
  return map;
}

function ContextCard({ meeting }: { meeting: Meeting }) {
  const [context, setContext] = useState(meeting.context ?? '');
  const [selectedTags, setSelectedTags] = useState<string[]>(meeting.tags ?? []);
  const [open, setOpen] = useState(!meeting.context?.trim() && (!meeting.tags || meeting.tags.length === 0));
  const [saved, setSaved] = useState(false);
  const [availableContexts, setAvailableContexts] = useState<MiniContext[]>([]);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const toast = useToast();

  const loadMiniContextsList = () => {
    void getMiniContexts().then(setAvailableContexts).catch(() => undefined);
  };

  useEffect(() => {
    loadMiniContextsList();
    return watchStorage(loadMiniContextsList, [MINI_CONTEXTS_KEY]);
  }, []);

  useEffect(() => {
    let alive = true;
    void getContext(meeting.id).then((stored) => {
      if (alive) {
        const val = stored || meeting.context || '';
        setContext(val);
      }
    });
    void getMeetingTags(meeting.id).then((storedTags) => {
      if (alive) {
        setSelectedTags(storedTags || meeting.tags || []);
      }
    });
    return () => {
      alive = false;
    };
  }, [meeting.id, meeting.context, meeting.tags]);

  useEffect(() => {
    return watchStorage(() => {
      void getContext(meeting.id).then((ctx) => {
        if (ctx !== undefined) setContext(ctx);
      });
      void getMeetingTags(meeting.id).then((tags) => {
        if (tags !== undefined) setSelectedTags(tags);
      });
    }, [CONTEXT_PREFIX + meeting.id, MEETING_TAGS_PREFIX + meeting.id]);
  }, [meeting.id]);

  const tagToContexts = useMemo(() => buildTagToContextsMap(availableContexts), [availableContexts]);

  const uniqueTags = useMemo(() => {
    return Array.from(tagToContexts.keys()).sort();
  }, [tagToContexts]);

  const tagCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const [tg, list] of tagToContexts.entries()) {
      map.set(tg, list.length);
    }
    return map;
  }, [tagToContexts]);

  const handleSave = async () => {
    await saveContext(meeting.id, context);
    await db('set-session-agenda', { id: meeting.id, agenda: context }).catch(() => undefined);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    toast('success', t('ext.summary.contextSaved'));
  };

  const toggleTag = async (tag: string) => {
    const lower = tag.toLowerCase();
    const isAttached = selectedTags.some((t) => t.toLowerCase() === lower);
    const nextTags = isAttached
      ? selectedTags.filter((t) => t.toLowerCase() !== lower)
      : [...selectedTags, lower];
    setSelectedTags(nextTags);
    await saveMeetingTags(meeting.id, nextTags).catch(() => undefined);
    toast('success', t(isAttached ? 'ext.header.tagDetached' : 'ext.header.tagAttached', { tag }));
  };

  const isCtxActive = (ctx: MiniContext) => {
    const termLower = ctx.term.toLowerCase();
    return selectedTags.some(
      (t) => t.toLowerCase() === termLower || ctx.tags.some((tg) => tg.toLowerCase() === t.toLowerCase())
    );
  };

  const toggleSingle = async (ctx: MiniContext) => {
    const termLower = ctx.term.toLowerCase();
    const isAttached = selectedTags.some((t) => t.toLowerCase() === termLower);
    const nextTags = isAttached
      ? selectedTags.filter((t) => t.toLowerCase() !== termLower)
      : [...selectedTags, termLower];
    setSelectedTags(nextTags);
    await saveMeetingTags(meeting.id, nextTags).catch(() => undefined);
    toast('success', t(isAttached ? 'ext.header.tagDetached' : 'ext.header.tagAttached', { tag: ctx.term }));
  };

  const hasContext = !!context.trim() || selectedTags.length > 0;

  return (
    <div className="summary-context-card border border-border/50 rounded-lg p-3 bg-muted/20 mb-4">
      <Button
        type="button"
        variant="ghost"
        className="summary-context-header w-full justify-between h-auto p-0 hover:bg-transparent font-normal"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="summary-context-title font-medium text-xs text-foreground flex items-center gap-1.5">
          {t('ext.summary.contextTitle')}
          {hasContext && <span className="context-indicator size-1.5 rounded-full bg-primary" />}
        </span>
        <span className="summary-context-preview dim text-xs text-muted-foreground truncate max-w-xs">
          {context.trim()
            ? context.trim().slice(0, 45) + (context.trim().length > 45 ? '…' : '')
            : selectedTags.length > 0
              ? selectedTags.map((tg) => `#${tg}`).join(' ')
              : t('ext.summary.contextHint')}
        </span>
        <span className="summary-context-arrow text-muted-foreground">
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </span>
      </Button>
      {open && (
        <div className="summary-context-body mt-3 flex flex-col gap-2.5">
          <Textarea
            className="summary-context-input text-xs"
            value={context}
            placeholder={t('ext.summary.contextPlaceholder')}
            onChange={(e) => setContext(e.target.value)}
            onBlur={handleSave}
            rows={3}
          />
          {selectedTags.length > 0 && (
            <div className="summary-active-tags-row flex items-center gap-2 flex-wrap text-xs">
              <span className="summary-active-tags-label text-muted-foreground">{t('ext.header.activeTags')}:</span>
              <div className="summary-active-tags-list flex items-center gap-1.5 flex-wrap">
                {selectedTags.map((tg) => (
                  <Badge key={tg} variant="secondary" className="summary-active-tag-chip gap-1 text-xs py-0.5">
                    #{tg}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="summary-active-tag-remove size-3.5 p-0 hover:text-destructive"
                      onClick={() => void toggleTag(tg)}
                      aria-label={t('ext.header.close')}
                    >
                      <X className="size-2.5" />
                    </Button>
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <div className="summary-context-quick-insert flex flex-col gap-1.5 text-xs">
            <span className="quick-insert-label text-muted-foreground font-medium flex items-center gap-1">
              <Sparkles className="size-3 text-primary" />
              {t('ext.header.insertContext')}:
            </span>
            <div className="quick-insert-tags flex items-center gap-1.5 flex-wrap" title={t('ext.header.insertByTag')}>
              {uniqueTags.map((tg) => {
                const count = tagCounts.get(tg) ?? 0;
                const isAttached = selectedTags.some((t) => t.toLowerCase() === tg.toLowerCase());
                return (
                  <Button
                    key={tg}
                    type="button"
                    variant={isAttached ? 'default' : 'outline'}
                    size="xs"
                    className="quick-insert-tag-btn h-6 text-xs gap-1"
                    onClick={() => void toggleTag(tg)}
                    title={t('ext.header.insertAllWithTag', { tag: tg, count })}
                  >
                    {isAttached ? <Check className="size-2.5" /> : <Plus className="size-2.5" />}
                    #{tg}
                    <span className="tag-count opacity-70">({count})</span>
                  </Button>
                );
              })}
              {availableContexts.length > 0 && (
                <div className="quick-insert-single-wrap relative inline-block">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="quick-insert-single-btn h-6 text-xs gap-1"
                    onClick={() => setPopoverOpen((v) => !v)}
                  >
                    <Sparkles className="size-2.5 text-primary" />
                    {t('ext.header.insertSingle')}
                    <ChevronDown className="size-2.5" />
                  </Button>
                  {popoverOpen && (
                    <div className="quick-insert-popover absolute left-0 top-full mt-1 z-50 w-72 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-2 shadow-md">
                      <div className="quick-insert-popover-head flex items-center justify-between pb-1.5 mb-1.5 border-b border-border/40 text-xs font-semibold">
                        <span>{t('ext.header.contextPopoverTitle')}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="size-4 p-0"
                          onClick={() => setPopoverOpen(false)}
                          aria-label={t('ext.header.close')}
                        >
                          <X className="size-3" />
                        </Button>
                      </div>
                      <div className="quick-insert-popover-list flex flex-col gap-1">
                        {availableContexts.map((ctx) => {
                          const active = isCtxActive(ctx);
                          return (
                            <Button
                              key={ctx.id}
                              type="button"
                              variant={active ? 'secondary' : 'ghost'}
                              size="xs"
                              className="w-full justify-start text-left h-auto py-1 px-1.5 text-xs truncate"
                              onClick={() => void toggleSingle(ctx)}
                            >
                              <span className="truncate">{active ? '✓ ' : '+ '}{ctx.term}</span>
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {availableContexts.length === 0 && (
                <span className="dim text-[11px] text-muted-foreground">
                  {t('ext.header.noContextsAvailable')}
                </span>
              )}
            </div>
          </div>
          <div className="summary-context-footer flex items-center justify-end gap-2 pt-2 border-t border-border/40">
            <Button type="button" size="xs" onClick={handleSave}>
              {saved ? t('ext.summary.contextSaved') : t('ext.summary.contextSave')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  meeting: Meeting;
  record: AnalysisRecord | null;
  live: boolean;
}

export function SummaryView({ meeting, record, live }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const regenerate = async () => {
    setBusy(true);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'regenerate',
        meetingId: meeting.id,
      });
      if (res?.ok) toast('success', live ? t('ext.summary.momDone') : t('ext.summary.notesDone'));
      else toast('error', t('ext.failed', { error: res?.error ?? res?.reason ?? t('ext.unknownError') }));
    } catch (e) {
      toast('error', t('ext.failed', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  if (record?.status === 'done') {
    return (
      <>
        <div className="summary-meta dim text-xs text-muted-foreground mb-3 font-mono">
          Provider: {record.provider} · {new Date(record.generatedAt).toLocaleString(locale())}
          {record.provisional &&
            ' · MoM sementara dari transcript sejauh ini — diganti otomatis setelah meeting selesai'}
        </div>
        <ContextCard meeting={meeting} />
        <Result meeting={meeting} analysis={record.analysis} />
      </>
    );
  }

  if (record?.status === 'processing') {
    const steps = ['Transcript', 'AI Processing', t('ext.summary.step.saving')];
    const active = record.step === 'ai' ? 1 : 2;
    const stale = Date.now() - Date.parse(record.startedAt) > STALE_PROCESSING_MS;
    return (
      <div className="summary-body space-y-4">
        <div className="progress flex items-center gap-3 p-3 rounded-lg border border-border/40 bg-muted/20" role="progressbar" aria-label="AI processing">
          {steps.map((s, i) => (
            <div key={s} className={`step flex items-center gap-1.5 text-xs font-medium ${i < active ? 'text-primary' : i === active ? 'text-foreground' : 'text-muted-foreground opacity-60'}`}>
              <span className={`step-dot size-2 rounded-full ${i < active ? 'bg-primary' : i === active ? 'bg-primary animate-pulse' : 'bg-muted-foreground/40'}`} />
              {s}
            </div>
          ))}
        </div>
        <p className="dim text-xs text-muted-foreground">{t('ext.summary.processingInfo')}</p>
        {stale && (
          <div className="subbar flex items-center justify-between p-2 rounded bg-warning/10 border border-warning/30">
            <span className="dim text-xs text-warning">
              {t('ext.summary.processingStale')}
            </span>
            <Button size="xs" variant="outline" onClick={regenerate} disabled={busy}>
              <RefreshCw className={`size-3 mr-1 ${busy ? 'animate-spin' : ''}`} />
              {busy ? t('ext.summary.processing') : t('ext.summary.regenerate')}
            </Button>
          </div>
        )}
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton skeleton-block h-12 w-full rounded-md bg-muted/50 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (record?.status === 'error') {
    return (
      <div className="empty-state p-8 text-center flex flex-col items-center gap-4">
        <div className="error-box p-4 rounded-lg border border-destructive/40 bg-destructive/10 text-left max-w-md w-full" role="alert">
          <div className="flex items-center gap-2 text-destructive font-semibold text-sm mb-1">
            <AlertTriangle className="size-4 shrink-0" />
            <strong>{t('ext.summary.analysisFailed')}</strong>
          </div>
          <p className="text-xs text-foreground/80">{record.error}</p>
        </div>
        <Button variant="default" onClick={regenerate} disabled={busy}>
          <RefreshCw className={`size-3.5 mr-1.5 ${busy ? 'animate-spin' : ''}`} />
          {busy ? t('ext.summary.processing') : t('ext.summary.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="empty-state p-8 text-center flex flex-col items-center gap-3">
      <div className="empty-glyph p-3 rounded-full bg-primary/10 text-primary border border-primary/20">
        <Sparkles className="size-8" />
      </div>
      <p className="font-semibold text-sm text-foreground">{live ? t('ext.summary.liveTitle') : t('ext.summary.emptyTitle')}</p>
      <p className="empty-hint text-xs text-muted-foreground max-w-sm">
        {live
          ? t('ext.summary.liveHint')
          : t('ext.summary.emptyHint')}
      </p>
      <ContextCard meeting={meeting} />
      <Button variant="default" onClick={regenerate} disabled={busy}>
        <Sparkles className={`size-3.5 mr-1.5 ${busy ? 'animate-spin' : ''}`} />
        {busy
          ? t('ext.summary.processing')
          : live
            ? t('ext.summary.makeMom')
            : t('ext.summary.generate')}
      </Button>
    </div>
  );
}
