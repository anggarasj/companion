import { useCallback, useEffect, useMemo, useState } from 'react';
import { locale, t } from '@meetcc/shared/i18n';
import {
  ANALYSIS_PREFIX,
  RESOLVED_PREFIX,
  buildAgenda,
  collectDecisions,
  collectOpenQuestions,
  decisionTopics,
  loadAllResolved,
  loadAnalyses,
  toggleResolved,
  watchStorage,
  type AnalysisRecord,
} from '@meetcc/shared';
import { useToast } from '@meetcc/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowUpRight,
  CheckCircle2,
  Copy,
  HelpCircle,
  X,
} from 'lucide-react';

interface Props {
  onClose: () => void;
  onOpenMeeting: (id: string) => void;
}

export function DecisionLog({ onClose, onOpenMeeting }: Props) {
  const [records, setRecords] = useState<Record<string, AnalysisRecord>>({});
  const [resolved, setResolved] = useState<Record<string, string[]>>({});
  const [topic, setTopic] = useState<string | null>(null);
  const toast = useToast();

  const refresh = useCallback(() => {
    void loadAnalyses().then(setRecords);
    void loadAllResolved().then(setResolved);
  }, []);

  useEffect(() => {
    refresh();
    return watchStorage(refresh, [ANALYSIS_PREFIX, RESOLVED_PREFIX]);
  }, [refresh]);

  const decisions = useMemo(() => collectDecisions(records), [records]);
  const topics = useMemo(() => decisionTopics(decisions), [decisions]);
  const shown = useMemo(
    () => (topic ? decisions.filter((d) => d.topic === topic) : decisions),
    [decisions, topic],
  );
  const questions = useMemo(
    () => collectOpenQuestions(records, resolved),
    [records, resolved],
  );
  const openCount = questions.filter((q) => !q.resolved).length;

  const onToggle = async (id: string, question: string) => {
    await toggleResolved(id, question);
    refresh();
  };

  const copyAgenda = async () => {
    await navigator.clipboard.writeText(buildAgenda(questions));
    toast('success', t('ext.decisions.copied'));
  };

  return (
    <div className="settings flex flex-col h-full bg-background overflow-y-auto">
      <header className="toolbar flex items-center justify-between p-3 border-b border-border/50">
        <div className="toolbar-title flex items-center gap-2">
          <CheckCircle2 className="size-5 text-primary" />
          <h1 className="text-base font-semibold text-foreground">{t('ext.decisions.title')}</h1>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label={t('ext.decisions.close')}
        >
          <X className="size-4" />
        </Button>
      </header>

      <div className="decisionlog-body p-4 space-y-6 max-w-4xl">
        <section>
          <div className="dl-head flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="section-label text-xs font-semibold uppercase text-muted-foreground tracking-wide">
              {t('ext.decisions.heading', { count: decisions.length })}
            </h2>
            {topics.length > 0 && (
              <div className="dl-filters flex items-center gap-1.5 flex-wrap" role="group" aria-label="Filter topik">
                <Button
                  variant={topic === null ? 'default' : 'outline'}
                  size="xs"
                  className="ask-chip rounded-full h-6 text-xs"
                  onClick={() => setTopic(null)}
                >
                  Semua
                </Button>
                {topics.map((item) => (
                  <Button
                    key={item}
                    variant={topic === item ? 'default' : 'outline'}
                    size="xs"
                    className="ask-chip rounded-full h-6 text-xs"
                    onClick={() => setTopic(item)}
                  >
                    {item}
                  </Button>
                ))}
              </div>
            )}
          </div>

          {shown.length ? (
            <ul className="dl-list space-y-2.5">
              {shown.map((d, i) => (
                <li key={`${d.meetingId}-${i}`} className="dl-card p-3 rounded-lg border border-border/50 bg-card shadow-xs text-xs space-y-1.5">
                  <div className="decision-what font-semibold text-foreground flex items-center gap-2 flex-wrap">
                    {d.what}
                    {d.topic && <Badge variant="outline" className="topic-tag text-[10px]">{d.topic}</Badge>}
                  </div>
                  {d.why && <div className="decision-why text-muted-foreground leading-relaxed">Alasan: {d.why}</div>}
                  {d.rejected.length > 0 && (
                    <div className="decision-rejected text-destructive/80">Ditolak: {d.rejected.join('; ')}</div>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    className="dl-link h-6 px-1.5 text-xs text-primary font-mono hover:underline"
                    onClick={() => onOpenMeeting(d.meetingId)}
                  >
                    <ArrowUpRight className="size-3 mr-1" />
                    {d.meetingId} · {new Date(d.generatedAt).toLocaleDateString(locale())}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="section-empty text-xs text-muted-foreground p-4 text-center">
              {decisions.length ? t('ext.decisions.emptyTopic') : t('ext.decisions.empty')}
            </p>
          )}
        </section>

        <section className="pt-4 border-t border-border/40">
          <div className="dl-head flex items-center justify-between gap-3 mb-3">
            <h2 className="section-label text-xs font-semibold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
              <HelpCircle className="size-3.5 text-primary" />
              {t('ext.decisions.carryHeading', { count: openCount })}
            </h2>
            <Button variant="outline" size="xs" onClick={copyAgenda} disabled={!openCount}>
              <Copy className="size-3 mr-1" />
              {'Copy agenda draft'}
            </Button>
          </div>

          {questions.length ? (
            <ul className="carry-list space-y-2">
              {questions.map((q, i) => (
                <li
                  key={`${q.meetingId}-${i}`}
                  className={`carry-item flex items-center justify-between p-2.5 rounded-lg border border-border/40 bg-card text-xs gap-3 ${q.resolved ? 'resolved opacity-60 line-through' : ''}`}
                >
                  <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                    <input
                      type="checkbox"
                      className="size-3.5 rounded border-border/60 text-primary cursor-pointer"
                      checked={q.resolved}
                      onChange={() => void onToggle(q.meetingId, q.question)}
                    />
                    <span className="carry-q text-foreground truncate">{q.question}</span>
                  </label>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="dl-link h-6 text-xs text-muted-foreground font-mono hover:text-primary"
                    onClick={() => onOpenMeeting(q.meetingId)}
                  >
                    <ArrowUpRight className="size-3 mr-1" />
                    {q.meetingId}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="section-empty text-xs text-muted-foreground p-4 text-center">{t('ext.decisions.noOpenQuestions')}</p>
          )}
        </section>
      </div>
    </div>
  );
}
