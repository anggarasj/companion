import { useEffect, useState } from 'react';
import { t } from '@meetcc/shared/i18n';
import type { Diagram, Meeting } from '@meetcc/shared';
import { lazyImport } from '../lib/lazy';
import { useToast } from '@meetcc/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Copy, Loader2, Sparkles, Workflow } from 'lucide-react';

type State =
  | { status: 'rendering' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; message: string };

/** Renders one Mermaid definition to inline SVG. Full syntax validation
 *  happens here (browser has the DOM the service worker lacks) — a bad
 *  diagram degrades to its source, the rest of the tab stays intact.
 *
 *  The wrapper is imported dynamically, the same way SummaryView's PDF export
 *  does it: a static import here would pull it into the main dashboard chunk
 *  and block that split for both call sites. */
function DiagramCard({ diagram, index }: { diagram: Diagram; index: number }) {
  const [state, setState] = useState<State>({ status: 'rendering' });
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    setState({ status: 'rendering' });
    lazyImport(() => import('../lib/mermaid'))
      .then(({ renderSvg }) => renderSvg(diagram.mermaid))
      .then((svg) => alive && setState({ status: 'ready', svg }))
      .catch((e: unknown) =>
        alive && setState({ status: 'error', message: (e as Error).message }),
      );
    return () => {
      alive = false;
    };
  }, [diagram.mermaid]);

  const copy = async () => {
    await navigator.clipboard.writeText(diagram.mermaid);
    toast('success', t('ext.diagram.copied'));
  };

  return (
    <figure className="diagram-card border border-border/50 rounded-lg p-3 bg-card shadow-xs mb-4" style={{ animationDelay: `${index * 70}ms` }}>
      <figcaption className="diagram-head flex items-center justify-between gap-2 mb-2 pb-2 border-b border-border/40">
        <div className="flex items-center gap-2">
          <Workflow className="size-4 text-primary shrink-0" />
          <span className="diagram-title font-semibold text-xs text-foreground">{diagram.title}</span>
          <Badge variant="outline" className="diagram-type text-[10px]">{diagram.type}</Badge>
        </div>
        <Button variant="ghost" size="xs" onClick={copy}>
          <Copy className="size-3 mr-1" />
          {'Copy source'}
        </Button>
      </figcaption>
      <div className="diagram-plate p-4 bg-muted/20 rounded-md overflow-x-auto">
        {state.status === 'rendering' && (
          <div className="diagram-loading flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground" aria-live="polite">
            <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
            Merender diagram…
          </div>
        )}
        {state.status === 'ready' && (
          // svg is sanitized by mermaid (securityLevel: 'strict')
          <div className="diagram-svg flex justify-center" dangerouslySetInnerHTML={{ __html: state.svg }} />
        )}
        {state.status === 'error' && (
          <div className="diagram-fallback p-3 rounded bg-destructive/10 border border-destructive/30 text-xs text-destructive" role="alert">
            <p className="diagram-err mb-1 font-medium">{t('ext.diagram.renderFailed', { message: state.message })}</p>
            <pre className="diagram-source font-mono text-[11px] p-2 bg-background/80 rounded overflow-x-auto text-foreground">{diagram.mermaid}</pre>
          </div>
        )}
      </div>
    </figure>
  );
}

interface Props {
  meeting: Meeting;
  diagrams: Diagram[];
  analysisReady: boolean;
}

export function DiagramView({ meeting, diagrams, analysisReady }: Props) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const generate = async () => {
    setBusy(true);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'generate-diagram',
        meetingId: meeting.id,
      });
      if (res?.ok) {
        toast(
          res.count ? 'success' : 'info',
          res.count
            ? `${res.count} diagram dibuat.`
            : t('ext.diagram.nothingToDraw'),
        );
      } else {
        toast('error', t('ext.failed', { error: res?.error ?? t('ext.unknownError') }));
      }
    } catch (e) {
      toast('error', t('ext.failed', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const genButton = (
    <Button
      variant="default"
      size="sm"
      onClick={generate}
      disabled={busy || !analysisReady}
      title={analysisReady ? '' : t('ext.diagram.needSummary')}
    >
      <Sparkles className={`size-3.5 mr-1.5 ${busy ? 'animate-spin' : ''}`} />
      {busy
        ? t('ext.diagram.generating')
        : diagrams.length
          ? t('ext.diagram.regenerate')
          : t('ext.diagram.generate')}
    </Button>
  );

  if (busy && !diagrams.length) {
    return (
      <div className="summary-body space-y-3 p-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton skeleton-block h-32 rounded-lg bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!diagrams.length) {
    return (
      <div className="empty-state p-8 text-center flex flex-col items-center gap-3">
        <div className="empty-glyph p-3 rounded-full bg-primary/10 text-primary border border-primary/20">
          <Workflow className="size-8" />
        </div>
        <p className="font-semibold text-sm text-foreground">{t('ext.diagram.empty')}</p>
        <p className="empty-hint text-xs text-muted-foreground max-w-sm">
          {analysisReady
            ? t('ext.diagram.hint', { id: meeting.id })
            : t('ext.diagram.hintNoSummary')}
        </p>
        {genButton}
      </div>
    );
  }
  return (
    <div className="p-3">
      <div className="subbar flex items-center justify-between mb-3 pb-2 border-b border-border/40">
        <span className="dim text-xs text-muted-foreground font-mono">
          {diagrams.length} diagram
        </span>
        {genButton}
      </div>
      <div className="diagram-scroll">
        {diagrams.map((d, i) => (
          <DiagramCard key={`${i}-${d.title}`} diagram={d} index={i} />
        ))}
      </div>
    </div>
  );
}
