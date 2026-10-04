import { useEffect, useState } from 'react';
import type { SessionRow } from '@meetcc/store';
import type { CarryOver } from '@meetcc/meeting';
import { carryOver, db, getSession, listProjects } from '../lib/db';
import {
  getContext,
  saveContext,
  watchStorage,
  CONTEXT_PREFIX,
} from '@meetcc/shared';
import { locale, t } from '@meetcc/shared/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ArrowUpRight,
  Calendar,
  Clock,
  Folder,
  Users,
  Video,
} from 'lucide-react';

function duration(ms: number | null): string {
  if (!ms || ms < 60_000) return '';
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const PLATFORM_LABEL: Record<string, string> = {
  'google-meet': 'Google Meet',
  teams: 'Microsoft Teams',
  zoom: 'Zoom',
  unknown: '',
};

export function MeetingHeader({
  sessionId,
  onOpenMeeting,
}: {
  sessionId: string;
  onOpenMeeting: (id: string) => void;
}) {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [carry, setCarry] = useState<CarryOver | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [failed, setFailed] = useState(false);
  const [agenda, setAgenda] = useState('');

  useEffect(() => {
    let alive = true;
    setFailed(false);
    Promise.all([
      getSession(sessionId),
      carryOver(sessionId),
      listProjects(),
      getContext(sessionId),
    ])
      .then(([s, c, p, ctx]) => {
        if (!alive) return;
        setSession(s);
        setAgenda(ctx || s?.agenda || '');
        setCarry(c);
        setProjects(p);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  useEffect(() => {
    return watchStorage(() => {
      void getContext(sessionId).then((ctx) => {
        if (ctx !== undefined) setAgenda(ctx);
      });
    }, [CONTEXT_PREFIX + sessionId]);
  }, [sessionId]);

  if (failed || !session) return null;

  const dateStr = session.startedAt
    ? new Date(session.startedAt).toLocaleString(locale(), {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  const durStr = duration(session.durationMs);
  const platformStr = PLATFORM_LABEL[session.platform] ?? session.platform;

  const assign = async (projectId: string) => {
    setSession({ ...session, projectId: projectId || null });
    await db('set-session-project', { id: sessionId, projectId }).catch(() => undefined);
  };

  const openCount = (carry?.openActions.length ?? 0) + (carry?.openQuestions.length ?? 0);

  return (
    <div className="meeting-header">
      <div className="mh-meta flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          {dateStr && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px]">
              <Calendar className="size-3 text-muted-foreground/70" />
              {dateStr}
            </span>
          )}
          {durStr && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3 text-muted-foreground/70" />
              {durStr}
            </span>
          )}
          {session.participants.length > 0 && (
            <span className="inline-flex items-center gap-1 mh-people" title={session.participants.join(', ')}>
              <Users className="size-3 text-muted-foreground/70" />
              {session.participants.slice(0, 4).join(', ')}
              {session.participants.length > 4 ? ` +${session.participants.length - 4}` : ''}
            </span>
          )}
          {platformStr && (
            <span className="inline-flex items-center gap-1">
              <Video className="size-3 text-muted-foreground/70" />
              {platformStr}
            </span>
          )}
        </div>

        <span className="spacer flex-1" />

        <div className="flex items-center gap-2">
          <Input
            className="mh-agenda h-7 w-48 text-xs bg-muted/30 border-border/50 focus-visible:ring-1"
            value={agenda}
            placeholder={t('ext.header.contextPlaceholder')}
            aria-label={t('ext.header.context')}
            title={t('ext.header.context')}
            onChange={(e) => setAgenda(e.target.value)}
            onBlur={() => {
              void saveContext(sessionId, agenda).catch(() => undefined);
              if (agenda === (session.agenda ?? '')) return;
              void db('set-session-agenda', { id: sessionId, agenda }).catch(() => undefined);
            }}
          />

          <label className="mh-project inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Folder className="size-3 text-muted-foreground/70" />
            <select
              className="h-7 rounded-md border border-border/50 bg-muted/30 px-2 text-xs text-foreground outline-none focus:border-ring"
              value={session.projectId ?? ''}
              onChange={(e) => void assign(e.target.value)}
            >
              <option value="">—</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {openCount > 0 && (
        <div className="mh-carry flex items-center gap-2 p-2 rounded-lg border border-amber/30 bg-amber/5 text-xs">
          <ArrowUpRight className="size-3.5 text-amber shrink-0" />
          <div className="flex items-center gap-1.5 flex-wrap">
            {t('ext.header.carryOpen', { count: '\u0000' })
              .split('\u0000')
              .flatMap((part, idx) =>
                idx === 0 ? [part] : [<strong key={idx} className="font-semibold text-foreground">{openCount}</strong>, part],
              )}
            {carry!.openActions.length > 0 && (
              <span className="dim text-muted-foreground">({t('ext.header.openActions', { count: carry!.openActions.length })})</span>
            )}
            {carry!.openQuestions.length > 0 && (
              <span className="dim text-muted-foreground">({t('ext.header.openQuestions', { count: carry!.openQuestions.length })})</span>
            )}
          </div>
          <span className="spacer flex-1" />
          <div className="flex items-center gap-1">
            {carry!.fromSessions.slice(0, 3).map((id) => (
              <Button
                key={id}
                variant="outline"
                size="xs"
                className="ask-chip h-6 text-xs border-border/60 hover:border-amber/50"
                onClick={() => onOpenMeeting(id)}
              >
                {t('ext.header.openPrevious')}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
