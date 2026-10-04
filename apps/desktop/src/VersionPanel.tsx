// The Version section of Settings: what is running, and a way to move to the
// newest build without waiting for the next launch's banner.
import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { t } from '@meetcc/shared/i18n'
import { Download, ExternalLink, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SETTING_HINT, SETTING_ROW } from '@/components/settingStyles'

const RELEASES_URL = 'https://github.com/suiflex/companion/releases'

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; update: Update }
  | { kind: 'installing'; update: Update }
  | { kind: 'failed'; update?: Update }

export function VersionPanel() {
  const [version, setVersion] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => undefined)
  }, [])

  async function checkNow(): Promise<void> {
    setState({ kind: 'checking' })
    try {
      const update = await check()
      setState(update ? { kind: 'available', update } : { kind: 'current' })
    } catch {
      setState({ kind: 'failed' })
    }
  }

  // Same path as the start-up banner: downloaded and signature-checked in
  // Rust, then the whole app relaunches — the main window included.
  async function install(update: Update): Promise<void> {
    setState({ kind: 'installing', update })
    try {
      await update.downloadAndInstall()
      await relaunch()
    } catch {
      setState({ kind: 'failed', update })
    }
  }

  const status =
    state.kind === 'checking'
      ? t('desktop.version.checking')
      : state.kind === 'current'
        ? t('desktop.version.upToDate')
        : state.kind === 'available' || state.kind === 'installing'
          ? t('desktop.update.available', { version: state.update.version })
          : state.kind === 'failed'
            ? t('desktop.update.failed')
            : t('desktop.version.hint')

  // A failed check has no update to retry; a failed install does.
  const pending = 'update' in state ? state.update : undefined

  return (
    <>
      <section className={SETTING_ROW}>
        <div>
          <h2>
            {t('desktop.version.current')}{' '}
            <Badge className="ml-1.5 border-transparent bg-primary/14 font-mono text-[11px] text-primary">{version ? `v${version}` : '…'}</Badge>
          </h2>
          <p className={SETTING_HINT} role="status">{status}</p>
        </div>
        <div className="flex flex-none items-center gap-2">
          {pending ? (
            <Button
              type="button"
              size="sm"
              disabled={state.kind === 'installing'}
              onClick={() => void install(pending)}
            >
              <Download />
              {state.kind === 'installing'
                ? t('desktop.update.installing')
                : state.kind === 'failed'
                  ? t('desktop.update.retry')
                  : t('desktop.update.restart')}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled={state.kind === 'checking'} onClick={() => void checkNow()}>
              <RefreshCw className={cn(state.kind === 'checking' && 'animate-spin')} />
              {t('desktop.version.check')}
            </Button>
          )}
        </div>
      </section>

      <section className={SETTING_ROW}>
        <div>
          <h2>{t('desktop.version.releases')}</h2>
          <p className={SETTING_HINT}>{t('desktop.version.releasesHint')}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void invoke('open_external', { url: RELEASES_URL })}>
          <ExternalLink />
          {t('desktop.version.openReleases')}
        </Button>
      </section>
    </>
  )
}
