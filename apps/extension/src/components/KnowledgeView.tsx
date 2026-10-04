import { useCallback, useEffect, useMemo, useState } from 'react';
import { locale, t } from '@meetcc/shared/i18n';
import {
  getMiniContexts,
  saveMiniContexts,
  watchStorage,
  MINI_CONTEXTS_KEY,
  type AskResult,
  type MiniContext,
} from '@meetcc/shared';
import type { ActionRow } from '@meetcc/store';
import { weeklyDigest, type Chronology } from '@meetcc/meeting';
import { chronology, listActions, setActionStatus } from '../lib/db';
import { db } from '../lib/db';
import { useToast } from '@meetcc/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Segmented } from './Segmented';
import {
  BookOpen,
  Calendar,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  HelpCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

interface GlobalAnswer extends AskResult {
  sessions: { id: string; title: string; startedAt: string | null }[];
}

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

/** Keys, not text: resolved at render time so the labels follow the language. */
const EVENT_LABEL: Record<Chronology['events'][number]['kind'], Parameters<typeof t>[0]> = {
  decision: 'ext.kind.decision',
  action: 'ext.kind.action',
  question: 'ext.kind.question',
  'question-resolved': 'ext.kind.questionResolved',
};

function ActionRowView({
  action,
  onChange,
  onPush,
  busy,
}: {
  action: ActionRow;
  onChange: (status: 'open' | 'done') => void;
  onPush: () => void;
  busy: boolean;
}) {
  return (
    <li className={`kb-action flex items-center justify-between gap-3 p-2.5 rounded-lg border border-border/40 bg-card text-xs ${action.status === 'done' ? 'done opacity-60' : ''}`}>
      <label className="kb-check flex items-center gap-2 cursor-pointer flex-1 min-w-0">
        <input
          type="checkbox"
          className="size-3.5 rounded border-border/60 text-primary cursor-pointer"
          checked={action.status === 'done'}
          onChange={(e) => onChange(e.target.checked ? 'done' : 'open')}
          aria-label={`Tandai selesai: ${action.task}`}
        />
        <span className={`kb-task text-foreground truncate ${action.status === 'done' ? 'line-through' : 'font-medium'}`}>{action.task}</span>
      </label>
      <span className="kb-action-meta dim text-[11px] text-muted-foreground shrink-0">
        {[action.owner, action.dueAt].filter(Boolean).join(' · ') || t('ext.kb.noOwner')}
      </span>
      {action.externalRef ? (
        <Badge
          variant="outline"
          className="kb-ref text-[10px] shrink-0 font-mono"
          title={t('ext.kb.alreadyPushed', { ref: action.externalRef })}
        >
          {action.externalRef}
        </Badge>
      ) : (
        <Button
          variant="outline"
          size="xs"
          className="kb-push shrink-0 h-6 text-xs gap-1"
          disabled={busy}
          onClick={onPush}
          title={t('ext.kb.pushToTracker')}
        >
          <ExternalLink className="size-3" />
          {'Kirim ke tracker'}
        </Button>
      )}
    </li>
  );
}

function ContextCardItem({
  ctx,
  onEdit,
  onDelete,
}: {
  ctx: MiniContext;
  onEdit: (ctx: MiniContext) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <article
      className="kb-context-card group p-3.5 rounded-xl border border-border/50 bg-card hover:border-primary/40 shadow-xs transition-all flex flex-col justify-between"
      role="button"
      tabIndex={0}
      onClick={() => onEdit(ctx)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit(ctx);
        }
      }}
    >
      <div>
        <div className="ctx-card-head flex items-start justify-between gap-2 mb-2">
          <div className="ctx-term-wrap flex items-center gap-1.5 flex-wrap">
            <span className="ctx-term font-semibold text-sm text-foreground">{ctx.term}</span>
            <span className="ctx-hover-hint opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-muted-foreground flex items-center gap-0.5">
              <Pencil className="size-2.5" />
              <span>{t('ext.kb.clickToEdit')}</span>
            </span>
          </div>
          <div className="ctx-tags flex items-center gap-1 flex-wrap">
            {ctx.tags.map((tg) => (
              <Badge key={tg} variant="secondary" className="ctx-tag-pill text-[10px] py-0">
                #{tg}
              </Badge>
            ))}
          </div>
        </div>
        <p className="ctx-def text-xs text-muted-foreground leading-relaxed line-clamp-3 mb-3">{ctx.definition}</p>
      </div>
      <div className="ctx-card-actions flex items-center justify-end gap-1.5 pt-2 border-t border-border/30">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ctx-btn text-xs h-6 px-2"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(ctx);
          }}
        >
          <Pencil className="size-3 mr-1" />
          {t('ext.kb.edit')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ctx-btn text-xs h-6 px-2 text-muted-foreground hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            void onDelete(ctx.id);
          }}
        >
          <Trash2 className="size-3 mr-1" />
          {t('ext.kb.deleteContext')}
        </Button>
      </div>
    </article>
  );
}

function RevisionTopicItem({
  topic,
  decisions,
  onOpenMeeting,
}: {
  topic: string;
  decisions: Chronology['revisions'][number]['decisions'];
  onOpenMeeting: (id: string) => void;
}) {
  return (
    <li className="kb-revision p-3 rounded-lg border border-border/40 bg-card mb-2.5 space-y-2 text-xs">
      <span className="kb-topic font-semibold text-foreground flex items-center gap-1.5">
        <HelpCircle className="size-3.5 text-primary" />
        {topic}
      </span>
      <div className="space-y-1.5 pl-2 border-l border-border/60">
        {decisions.map((d, i) => (
          <Button
            key={d.id}
            variant="ghost"
            className={`kb-rev-step w-full justify-start text-left h-auto py-1.5 px-2 text-xs font-normal gap-2 ${d.supersededBy ? 'superseded opacity-50 line-through' : ''}`}
            onClick={() => onOpenMeeting(d.sessionId)}
          >
            <span className="kb-rev-index font-mono text-[10px] text-muted-foreground shrink-0">{i + 1}.</span>
            <span className="text-foreground truncate">{d.decision}</span>
            {d.reason && <em className="dim text-muted-foreground truncate"> — {d.reason}</em>}
            {!d.supersededBy && (
              <Badge variant="outline" className="kb-standing text-[10px] text-emerald-500 border-emerald-500/30 ml-auto shrink-0">
                {t('ext.kb.standing')}
              </Badge>
            )}
          </Button>
        ))}
      </div>
    </li>
  );
}

function appendTagsToSet(set: Set<string>, tags: string[]): void {
  for (let j = 0; j < tags.length; j++) {
    set.add(tags[j].toLowerCase());
  }
}

function extractAllTags(contexts: MiniContext[]): string[] {
  const tagSet = new Set<string>();
  for (let i = 0; i < contexts.length; i++) {
    appendTagsToSet(tagSet, contexts[i].tags);
  }
  return Array.from(tagSet).sort();
}

function hasMatchingTag(tags: string[], target: string): boolean {
  for (let j = 0; j < tags.length; j++) {
    if (tags[j].toLowerCase() === target) return true;
  }
  return false;
}

function tagMatchesQuery(tags: string[], q: RegExp): boolean {
  for (let j = 0; j < tags.length; j++) {
    if (q.test(tags[j])) return true;
  }
  return false;
}

function contextMatchesSearch(c: MiniContext, q: RegExp): boolean {
  if (q.test(c.term)) return true;
  if (q.test(c.definition)) return true;
  return tagMatchesQuery(c.tags, q);
}

function filterContexts(contexts: MiniContext[], tagFilter: string | null, q: RegExp | null): MiniContext[] {
  const results: MiniContext[] = [];
  for (let i = 0; i < contexts.length; i++) {
    const c = contexts[i];
    if (tagFilter && !hasMatchingTag(c.tags, tagFilter)) continue;
    if (q && !contextMatchesSearch(c, q)) continue;
    results.push(c);
  }
  return results;
}

export function KnowledgeView({
  onOpenMeeting,
  onClose,
  seedQuestion,
}: {
  onOpenMeeting: (id: string) => void;
  onClose?: () => void;
  seedQuestion?: string;
}) {
  const [contexts, setContexts] = useState<MiniContext[]>([]);
  const [activeTab, setActiveTab] = useState<'contexts' | 'insights'>('contexts');
  const [activeTag, setActiveTag] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formTerm, setFormTerm] = useState('');
  const [formDef, setFormDef] = useState('');
  const [formSelectedTags, setFormSelectedTags] = useState<string[]>([]);
  const [customTagInput, setCustomTagInput] = useState('');

  const [question, setQuestion] = useState(seedQuestion || '');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<GlobalAnswer | null>(null);

  const [story, setStory] = useState<Chronology | null>(null);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [pushing, setPushing] = useState<number | null>(null);
  const [syncingIssues, setSyncingIssues] = useState(false);
  const toast = useToast();

  const loadData = useCallback(() => {
    void getMiniContexts().then(setContexts);
  }, []);

  useEffect(() => {
    loadData();
    return watchStorage(loadData, [MINI_CONTEXTS_KEY]);
  }, [loadData]);

  const refreshInsights = useCallback(() => {
    void chronology().then(setStory).catch(() => undefined);
    void listActions().then(setActions).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (activeTab === 'insights') refreshInsights();
  }, [activeTab, refreshInsights]);

  const allTags = useMemo(() => extractAllTags(contexts), [contexts]);

  const searchRegex = useMemo(() => {
    const q = search.trim();
    if (!q) return null;
    try {
      return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch {
      return null;
    }
  }, [search]);

  const filteredContexts = useMemo(
    () => filterContexts(contexts, activeTag === 'all' ? null : activeTag, searchRegex),
    [contexts, activeTag, searchRegex],
  );

  const selectedTagSet = useMemo(
    () => new Set(formSelectedTags.map((t) => t.toLowerCase())),
    [formSelectedTags],
  );

  const toggleTag = (tag: string) => {
    const lower = tag.toLowerCase();
    if (selectedTagSet.has(lower)) {
      setFormSelectedTags(formSelectedTags.filter((t) => t.toLowerCase() !== lower));
    } else {
      setFormSelectedTags([...formSelectedTags, lower]);
    }
  };

  const removeTag = (tag: string) => {
    const lower = tag.toLowerCase();
    setFormSelectedTags(formSelectedTags.filter((t) => t.toLowerCase() !== lower));
  };

  const addCustomTag = () => {
    const parts = customTagInput
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0 && !selectedTagSet.has(s));
    if (parts.length > 0) {
      setFormSelectedTags([...formSelectedTags, ...parts]);
      setCustomTagInput('');
    }
  };

  const handleSaveContext = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTerm.trim() || !formDef.trim()) return;

    let updated: MiniContext[];
    if (editingId) {
      updated = contexts.map((c) =>
        c.id === editingId
          ? {
              ...c,
              term: formTerm.trim(),
              definition: formDef.trim(),
              tags: formSelectedTags,
              updatedAt: new Date().toISOString(),
            }
          : c,
      );
    } else {
      const newCtx: MiniContext = {
        id: crypto.randomUUID(),
        term: formTerm.trim(),
        definition: formDef.trim(),
        tags: formSelectedTags,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      updated = [...contexts, newCtx];
    }

    await saveMiniContexts(updated);
    setIsEditing(false);
    setEditingId(null);
    setFormTerm('');
    setFormDef('');
    setFormSelectedTags([]);
    toast('success', t('ext.kb.contextSaved'));
  };

  const handleEdit = (ctx: MiniContext) => {
    setFormTerm(ctx.term);
    setFormDef(ctx.definition);
    setFormSelectedTags([...ctx.tags]);
    setEditingId(ctx.id);
    setIsEditing(true);
  };

  const handleDelete = async (id: string) => {
    const next = contexts.filter((c) => c.id !== id);
    await saveMiniContexts(next);
    if (editingId === id) setIsEditing(false);
    toast('info', t('ext.kb.contextDeleted'));
  };

  const ask = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || asking) return;
    setAsking(true);
    setAnswer(null);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ask-all',
        question: trimmed,
      });
      if (res?.ok) {
        setAnswer(res.answer);
      } else {
        toast('error', t('ext.failed', { error: res?.error ?? t('ext.unknownError') }));
      }
    } catch (e) {
      toast('error', t('ext.failed', { error: (e as Error).message }));
    } finally {
      setAsking(false);
    }
  };

  const toggle = async (action: ActionRow, nextStatus: 'open' | 'done') => {
    await setActionStatus(action.id, nextStatus);
    setActions((prev) =>
      prev.map((a) => (a.id === action.id ? { ...a, status: nextStatus } : a)),
    );
  };

  const push = async (action: ActionRow) => {
    setPushing(action.id);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'tracker-push',
        actionId: action.id,
      });
      if (res?.ok) {
        toast('success', t('ext.kb.created', { ref: res.ref }));
        refreshInsights();
      } else {
        toast('error', t('ext.failed', { error: res?.error ?? t('ext.unknownError') }));
      }
    } catch (e) {
      toast('error', t('ext.failed', { error: (e as Error).message }));
    } finally {
      setPushing(null);
    }
  };

  const refreshIssues = async () => {
    setSyncingIssues(true);
    try {
      const res = await db<{ checked: number; changed: number; failed: unknown[] }>(
        'sync-tracker-issues',
        {},
      );
      toast(
        res.failed.length ? 'error' : 'success',
        `${res.checked} issue dicek, ${res.changed} status diperbarui` +
          (res.failed.length ? `, ${res.failed.length} gagal` : ''),
      );
      refreshInsights();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSyncingIssues(false);
    }
  };

  const visibleActions = showDone ? actions : actions.filter((a) => a.status === 'open');

  return (
    <div className="kb flex flex-col h-full bg-background overflow-y-auto">
      <header className="toolbar flex items-center justify-between p-3 border-b border-border/50">
        <div className="toolbar-title flex items-center gap-2">
          <BookOpen className="size-5 text-primary" />
          <h1 className="text-base font-semibold text-foreground">{t('ext.kb.contextTitle')}</h1>
        </div>
        <nav className="tabs">
          <Segmented
            ariaLabel={t('ext.kb.contextTitle')}
            role="tablist"
            options={[
              { value: 'contexts', label: t('ext.kb.tabContexts'), icon: BookOpen },
              { value: 'insights', label: t('ext.kb.tabInsights'), icon: Sparkles },
            ]}
            value={activeTab}
            onChange={(value) => setActiveTab(value as typeof activeTab)}
          />
        </nav>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label={t('ext.header.close')}
          >
            <X className="size-4" />
          </Button>
        )}
      </header>

      {activeTab === 'contexts' ? (
        <section className="kb-contexts-section p-4 space-y-4 max-w-5xl">
          <div className="kb-contexts-header flex items-center justify-between gap-3 flex-wrap">
            <p className="hint text-xs text-muted-foreground">{t('ext.kb.contextDesc')}</p>
            <Button
              type="button"
              variant={isEditing ? 'outline' : 'default'}
              size="sm"
              className="kb-add-btn gap-1.5"
              onClick={() => {
                if (isEditing) {
                  setIsEditing(false);
                  setEditingId(null);
                } else {
                  setFormTerm('');
                  setFormDef('');
                  setFormSelectedTags([]);
                  setCustomTagInput('');
                  setEditingId(null);
                  setIsEditing(true);
                }
              }}
            >
              {isEditing ? (
                <>
                  <X className="size-3.5" />
                  {t('ext.kb.cancel')}
                </>
              ) : (
                <>
                  <Plus className="size-3.5" />
                  {t('ext.kb.addContext')}
                </>
              )}
            </Button>
          </div>

          {isEditing && (
            <form className="kb-context-form p-4 rounded-xl border border-primary/30 bg-card shadow-sm space-y-3.5" onSubmit={handleSaveContext}>
              <h3 className="form-title text-sm font-semibold text-foreground">
                {editingId ? t('ext.kb.editContext') : t('ext.kb.addContext')}
              </h3>
              <label className="field flex flex-col gap-1 text-xs">
                <span className="font-medium text-foreground">{t('ext.kb.term')}</span>
                <Input
                  type="text"
                  required
                  className="h-8 text-xs"
                  value={formTerm}
                  placeholder={t('ext.kb.termPlaceholder')}
                  onChange={(e) => setFormTerm(e.target.value)}
                />
              </label>

              <div className="field kb-tag-selector flex flex-col gap-1.5 text-xs">
                <span className="font-medium text-foreground">{t('ext.kb.tags')}</span>

                {allTags.length > 0 && (
                  <div className="kb-ref-tags-box p-2.5 rounded-lg border border-border/40 bg-muted/20 space-y-1.5">
                    <span className="kb-ref-tags-hint text-[11px] text-muted-foreground block">{t('ext.kb.selectExistingTags')}</span>
                    <div className="kb-ref-tag-pills flex items-center gap-1.5 flex-wrap">
                      {allTags.map((tag) => {
                        const selected = selectedTagSet.has(tag.toLowerCase());
                        return (
                          <Button
                            key={tag}
                            type="button"
                            variant={selected ? 'default' : 'outline'}
                            size="xs"
                            className={`ref-tag-pill h-6 text-xs gap-1 rounded-full ${selected ? 'selected' : ''}`}
                            onClick={() => toggleTag(tag)}
                          >
                            <span>#{tag}</span>
                            {selected && <Check className="size-2.5" />}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="kb-tag-input-row flex items-center gap-2">
                  <Input
                    type="text"
                    className="kb-new-tag-input h-8 text-xs flex-1"
                    value={customTagInput}
                    placeholder={t('ext.kb.tagsPlaceholder')}
                    onChange={(e) => setCustomTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        addCustomTag();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="kb-add-tag-btn h-8 text-xs gap-1"
                    onClick={addCustomTag}
                  >
                    <Plus className="size-3" />
                    {t('ext.kb.addTag')}
                  </Button>
                </div>

                {formSelectedTags.length > 0 && (
                  <div className="kb-selected-tags-row flex items-center gap-1.5 flex-wrap text-xs pt-1">
                    <span className="kb-selected-tags-label text-muted-foreground">{t('ext.kb.selectedTags')}:</span>
                    <div className="kb-selected-pills flex items-center gap-1.5 flex-wrap">
                      {formSelectedTags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="selected-tag-pill gap-1 text-xs">
                          #{tag}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="remove-tag-btn size-3.5 p-0 hover:text-destructive"
                            onClick={() => removeTag(tag)}
                            aria-label={t('ext.kb.removeTag', { tag })}
                          >
                            <X className="size-2.5" />
                          </Button>
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <label className="field flex flex-col gap-1 text-xs">
                <span className="font-medium text-foreground">{t('ext.kb.definition')}</span>
                <Textarea
                  required
                  rows={3}
                  className="text-xs"
                  value={formDef}
                  placeholder={t('ext.kb.definitionPlaceholder')}
                  onChange={(e) => setFormDef(e.target.value)}
                />
              </label>
              <div className="subbar flex items-center justify-end gap-2 pt-2 border-t border-border/40">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setIsEditing(false);
                    setEditingId(null);
                  }}
                >
                  {t('ext.kb.cancel')}
                </Button>
                <Button variant="default" size="sm" type="submit">
                  {t('ext.kb.saveContext')}
                </Button>
              </div>
            </form>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <div className="kb-tag-pills flex items-center gap-1.5 flex-wrap flex-1">
              <Button
                type="button"
                variant={activeTag === 'all' ? 'default' : 'outline'}
                size="xs"
                className={`tag-pill rounded-full h-6 text-xs ${activeTag === 'all' ? 'active' : ''}`}
                onClick={() => setActiveTag('all')}
              >
                #{t('ext.kb.allTags')}
              </Button>
              {allTags.map((tag) => (
                <Button
                  key={tag}
                  type="button"
                  variant={activeTag === tag ? 'default' : 'outline'}
                  size="xs"
                  className={`tag-pill rounded-full h-6 text-xs ${activeTag === tag ? 'active' : ''}`}
                  onClick={() => setActiveTag(activeTag === tag ? 'all' : tag)}
                >
                  #{tag}
                </Button>
              ))}
            </div>
            <div className="relative w-64">
              <Search className="size-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <Input
                type="search"
                className="kb-search-input h-8 pl-8 text-xs"
                value={search}
                placeholder={t('ext.kb.searchContexts')}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {filteredContexts.length === 0 ? (
            <p className="section-empty text-xs text-muted-foreground p-8 text-center">
              {contexts.length === 0 ? t('ext.kb.noContexts') : t('ext.kb.noMatchingContexts')}
            </p>
          ) : (
            <div className="kb-context-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredContexts.map((ctx) => (
                <ContextCardItem
                  key={ctx.id}
                  ctx={ctx}
                  onEdit={handleEdit}
                  onDelete={(id) => void handleDelete(id)}
                />
              ))}
            </div>
          )}
        </section>
      ) : (
        <div className="kb-insights-wrap p-4 space-y-6 max-w-5xl">
          <section className="kb-ask">
            <form
              className="ask-composer flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(question);
              }}
            >
              <Textarea
                className="ask-input min-h-[38px] max-h-32 text-xs py-2 resize-none flex-1"
                rows={1}
                value={question}
                placeholder={t('ext.kb.askPlaceholder')}
                aria-label={t('ext.kb.askLabel')}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void ask(question);
                  }
                }}
              />
              <Button variant="default" size="sm" type="submit" disabled={asking || !question.trim()}>
                <Send className="size-3.5 mr-1" />
                {asking ? '…' : t('ext.kb.ask')}
              </Button>
            </form>

            {answer && (
              <article className="kb-answer mt-3 p-4 rounded-xl border border-border/60 bg-card shadow-xs space-y-3">
                <div className="ask-grades flex items-center gap-1.5 flex-wrap">
                  {answer.sessions.map((s) => (
                    <Button
                      key={s.id}
                      variant="outline"
                      size="xs"
                      className="ask-chip rounded-full h-6 text-xs"
                      onClick={() => onOpenMeeting(s.id)}
                    >
                      {s.title || s.id} · {fmtDate(s.startedAt)}
                    </Button>
                  ))}
                </div>
                {answer.evidence.length > 0 && (
                  <ul className="kb-evidence space-y-1.5">
                    {answer.evidence.map((e, i) => (
                      <li key={i} className="p-2 rounded bg-muted/30 border border-border/30 text-xs">
                        <span className="ask-ev-who font-mono text-[10px] text-primary block mb-0.5">{e.speakers.join(', ')}</span>
                        <span className="ask-ev-text text-foreground/90">{e.preview}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            )}
          </section>

          <div className="kb-digest flex items-center justify-between pb-3 border-b border-border/40">
            <Button
              variant="outline"
              size="sm"
              className="kb-refresh text-xs gap-1.5"
              disabled={!story}
              title={t('ext.kb.copyDigest')}
              onClick={async () => {
                if (!story) return;
                await navigator.clipboard.writeText(weeklyDigest(story));
                toast('success', t('ext.kb.digestCopied'));
              }}
            >
              <Copy className="size-3.5" />
              {'Salin digest mingguan'}
            </Button>
          </div>

          <div className="kb-cols grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="kb-col space-y-3">
              <h2 className="section-label text-xs font-semibold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
                <CheckCircle2 className="size-4 text-primary" />
                {t('ext.kb.actionItems')}{' '}
                {story?.overdueActions?.length
                  ? t('ext.kb.overdue', { count: story.overdueActions.length })
                  : ''}
              </h2>
              <div className="kb-toggle-row flex items-center justify-between gap-2">
                <label className="kb-toggle flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    className="size-3.5 rounded border-border/60 text-primary cursor-pointer"
                    checked={showDone}
                    onChange={(e) => setShowDone(e.target.checked)}
                  />
                  {t('ext.kb.showDone')}
                </label>
                {actions.some((a) => a.externalRef) && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="kb-refresh text-xs gap-1"
                    disabled={syncingIssues}
                    onClick={() => void refreshIssues()}
                  >
                    <RefreshCw className={`size-3 ${syncingIssues ? 'animate-spin' : ''}`} />
                    {syncingIssues ? t('ext.kb.checkingTracker') : t('ext.kb.pullTracker')}
                  </Button>
                )}
              </div>
              {visibleActions.length ? (
                <ul className="kb-list space-y-2">
                  {visibleActions.map((a) => (
                    <ActionRowView
                      key={a.id}
                      action={a}
                      busy={pushing === a.id}
                      onChange={(status) => void toggle(a, status)}
                      onPush={() => void push(a)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="section-empty text-xs text-muted-foreground p-4 text-center">{t('ext.kb.noOpenActions')}</p>
              )}
            </section>

            <section className="kb-col space-y-4">
              <div className="space-y-3">
                <h2 className="section-label text-xs font-semibold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
                  <HelpCircle className="size-4 text-primary" />
                  {t('ext.kb.changedDecisions')}
                </h2>
                {story?.revisions?.length ? (
                  <ul className="kb-list space-y-2">
                    {story.revisions.map((r) => (
                      <RevisionTopicItem
                        key={r.topic}
                        topic={r.topic}
                        decisions={r.decisions}
                        onOpenMeeting={onOpenMeeting}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="section-empty text-xs text-muted-foreground p-4 text-center">{t('ext.kb.noRepeatedTopics')}</p>
                )}
              </div>

              <div className="space-y-3 pt-3 border-t border-border/40">
                <h2 className="section-label text-xs font-semibold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
                  <Calendar className="size-4 text-primary" />
                  {t('ext.kb.chronology')}
                </h2>
                {story?.events?.length ? (
                  <ol className="kb-timeline space-y-2 max-h-96 overflow-y-auto pr-1">
                    {story.events.slice(-40).map((e, i) => (
                      <li key={`${e.kind}-${e.entityId}-${i}`}>
                        <Button
                          variant="ghost"
                          className="kb-event w-full justify-start text-left h-auto p-2 rounded-lg border border-border/30 bg-card hover:bg-muted/30 text-xs font-normal flex flex-col items-start gap-1"
                          onClick={() => onOpenMeeting(e.sessionId)}
                        >
                          <div className="flex items-center gap-1.5 w-full">
                            <Badge variant="outline" className={`kb-event-kind kind-${e.kind} text-[10px]`}>
                              {t(EVENT_LABEL[e.kind])}
                            </Badge>
                            <span className="dim text-[11px] font-mono text-muted-foreground ml-auto">
                              {e.sessionTitle} · {fmtDate(e.at)}
                            </span>
                          </div>
                          <span className="kb-event-text text-foreground/90">{e.text}</span>
                        </Button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="section-empty text-xs text-muted-foreground p-4 text-center">{t('ext.kb.noAnalysed')}</p>
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
