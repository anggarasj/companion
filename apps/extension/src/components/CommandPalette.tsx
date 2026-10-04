import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit } from '@meetcc/store';
import { displayMeetingId } from '@meetcc/shared';
import { locale, t } from '@meetcc/shared/i18n';
import { search } from '../lib/db';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  HelpCircle,
  ListTodo,
  MessageSquare,
  Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

/** Keys, not text: resolved at render time so the labels follow the language. */
const KIND_LABEL: Record<SearchHit['kind'], Parameters<typeof t>[0]> = {
  transcript: 'ext.kind.transcript',
  decision: 'ext.kind.decision',
  action: 'ext.kind.action',
  question: 'ext.kind.question',
  document: 'ext.kind.document',
  risk: 'ext.kind.risk',
};

const KIND_ICON: Record<SearchHit['kind'], LucideIcon> = {
  transcript: MessageSquare,
  decision: CheckCircle2,
  action: ListTodo,
  question: HelpCircle,
  document: FileText,
  risk: AlertTriangle,
};

/** Long enough that FTS is meaningful, short enough to feel instant. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 180;

function fmt(time: string | null): string {
  if (!time) return '';
  const d = new Date(time);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

export function CommandPalette({
  open,
  onClose,
  onOpenMeeting,
  onAskAll,
}: {
  open: boolean;
  onClose: () => void;
  onOpenMeeting: (sessionId: string) => void;
  onAskAll: (question: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setHits([]);
      setActive(0);
      setError('');
      input.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open || query.trim().length < MIN_QUERY) {
      setHits([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      search(query)
        .then((r) => {
          if (!alive) return;
          setHits(r);
          setActive(0);
          setError('');
        })
        .catch((e: Error) => alive && setError(e.message));
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, open]);

  // grouped by meeting, but each row keeps its rank in the flat list so the
  // keyboard cursor stays in sync without scanning the results per row
  const grouped = useMemo(() => {
    const map = new Map<string, { hit: SearchHit; index: number }[]>();
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const list = map.get(h.sessionId) ?? [];
      list.push({ hit: h, index: i });
      map.set(h.sessionId, list);
    }
    return Array.from(map.entries());
  }, [hits]);

  if (!open) return null;

  const choose = (hit: SearchHit): void => {
    onOpenMeeting(hit.sessionId);
    onClose();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('ext.palette.search')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="relative flex items-center border-b border-border/60 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground mr-2" />
          <Input
            ref={input}
            className="palette-input border-0 shadow-none px-0 h-11 text-sm bg-transparent focus-visible:ring-0 focus-visible:border-0"
            value={query}
            placeholder={t('ext.palette.placeholder')}
            aria-label={t('ext.palette.keywords')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, hits.length - 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              }
              if (e.key === 'Enter' && hits[active]) choose(hits[active]);
            }}
          />
        </div>

        <div className="palette-results">
          {error && <p className="palette-empty danger-text">{error}</p>}
          {!error && query.trim().length >= MIN_QUERY && !hits.length && (
            <p className="palette-empty">{t('ext.palette.empty')}</p>
          )}
          {!error && query.trim().length < MIN_QUERY && (
            <p className="palette-empty">Ketik minimal {MIN_QUERY} huruf.</p>
          )}

          {grouped.map(([sessionId, rows]) => (
            <section key={sessionId} className="palette-group">
              <h3 className="palette-group-title">
                {rows[0].hit.sessionTitle || displayMeetingId(sessionId)}
              </h3>
              {rows.map(({ hit, index }) => {
                const Icon = KIND_ICON[hit.kind];
                return (
                  <button
                    key={`${hit.kind}-${hit.entityId}-${index}`}
                    className={`palette-hit ${index === active ? 'active' : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(hit)}
                  >
                    <Badge variant="outline" className={`palette-kind kind-${hit.kind} gap-1 font-normal`}>
                      {Icon && <Icon className="size-3 shrink-0" />}
                      {t(KIND_LABEL[hit.kind])}
                    </Badge>
                    <span className="palette-text">{hit.text}</span>
                    <span className="palette-meta dim">
                      {[hit.speaker, fmt(hit.time)].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>

        <div className="palette-foot flex items-center justify-between border-t border-border/60 px-3 py-2 bg-muted/20">
          <span className="dim text-xs text-muted-foreground">{t('ext.palette.keys')}</span>
          <Button
            variant="default"
            size="sm"
            className="h-8 gap-1.5"
            disabled={query.trim().length < MIN_QUERY}
            onClick={() => {
              onAskAll(query.trim());
              onClose();
            }}
          >
            <Sparkles className="size-3.5" />
            {t('ext.palette.askAi')}
          </Button>
        </div>
      </div>
    </div>
  );
}
