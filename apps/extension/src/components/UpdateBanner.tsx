import { useCallback, useEffect, useState } from 'react';
import {
  UPDATE_DISMISSED_KEY,
  UPDATE_KEY,
  updateAvailable,
  watchStorage,
  type UpdateState,
} from '@meetcc/shared';
import { useToast } from '@meetcc/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Copy, ExternalLink, Sparkles, X } from 'lucide-react';

const COMMAND = 'companion update';

/**
 * Tells the user a newer release exists. Chromium never auto-updates an
 * extension loaded unpacked, so without this the only way to find out is to
 * go looking — which is how people ended up reinstalling from scratch and
 * losing the meetings that lived under the old install path.
 *
 * The background service worker does the checking (see background.ts); this
 * only reads what it wrote.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>();
  const [dismissed, setDismissed] = useState<string>();
  const toast = useToast();
  const manifest = chrome.runtime.getManifest();
  const current = manifest.version;

  const load = useCallback(async () => {
    const stored = await chrome.storage.local.get([UPDATE_KEY, UPDATE_DISMISSED_KEY]);
    setState(stored[UPDATE_KEY] as UpdateState | undefined);
    setDismissed(stored[UPDATE_DISMISSED_KEY] as string | undefined);
  }, []);

  useEffect(() => {
    void load();
    return watchStorage(() => void load(), [UPDATE_KEY, UPDATE_DISMISSED_KEY]);
  }, [load]);

  if (!manifest.key || !updateAvailable(current, state, dismissed)) return null;

  return (
    <div className="update-banner flex items-center gap-2.5 p-2 px-3 bg-primary/10 border-b border-primary/20 text-xs text-foreground">
      <Sparkles className="size-4 text-primary shrink-0" />
      <Badge variant="outline" className="update-pill font-mono text-[10px] bg-background/60 border-primary/30 text-primary">
        v{state?.latest}
      </Badge>
      <span className="update-text flex-1 truncate">
        Versi baru tersedia. Jalankan <code className="font-mono text-primary font-semibold">{COMMAND}</code> di terminal, lalu restart browser Companion.
      </span>
      <Button
        variant="outline"
        size="xs"
        className="update-copy gap-1 h-6 text-xs bg-background/80"
        onClick={async () => {
          await navigator.clipboard.writeText(COMMAND);
          toast('success', 'Perintah update disalin.');
        }}
      >
        <Copy className="size-3" />
        {'Salin perintah'}
      </Button>
      <a className="update-link inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground underline ml-1" href={state?.url} target="_blank" rel="noreferrer">
        {'Catatan rilis'}
        <ExternalLink className="size-2.5" />
      </a>
      <Button
        variant="ghost"
        size="icon-xs"
        className="update-dismiss size-5 p-0 text-muted-foreground hover:text-foreground"
        aria-label="Tutup pemberitahuan update"
        title="Sembunyikan sampai rilis berikutnya"
        onClick={() => {
          // Per version, so the next release speaks up again.
          void chrome.storage.local.set({ [UPDATE_DISMISSED_KEY]: state?.latest });
        }}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}
