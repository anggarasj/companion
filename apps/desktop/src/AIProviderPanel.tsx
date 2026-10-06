// The desktop's AI provider settings.
//
// The same providers as the extension, from the same adapters — `packages/ai`
// is `fetch`-only and carries no `chrome.*`, so all of it is portable. What is
// not portable is the storage underneath, which is why `aiSettings.ts` exists.
//
// Sign-in providers (ChatGPT, Google) are offered but not wired here: the flow
// needs a browser round trip and a paste-back field, and shipping half of it
// would be worse than saying so.
import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { PROVIDER_PRESETS, createClient, listModels, resolveConfig, showsAsChips, validateSettings } from '@meetcc/ai'
import { switchProvider } from '@meetcc/shared/provider'
import type { ProviderId, Settings } from '@meetcc/shared/types'
import { t } from '@meetcc/shared/i18n'
import { Select } from './Select'
import { loadAiSettings, saveAiSettings } from './aiSettings'
import { ExternalLink, PlugZap, RefreshCw, Save } from 'lucide-react'
import { useToast } from './toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SETTING_HINT, SETTING_ROW } from '@/components/settingStyles'

const PROVIDERS = Object.entries(PROVIDER_PRESETS) as [ProviderId, (typeof PROVIDER_PRESETS)[ProviderId]][]

export function AIProviderPanel() {
  const toast = useToast()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState<'' | 'models' | 'test' | 'save'>('')

  useEffect(() => {
    void loadAiSettings().then(setSettings)
  }, [])

  const preset = useMemo(
    () => (settings ? PROVIDER_PRESETS[settings.provider] : null),
    [settings],
  )

  if (!settings || !preset) return <p className={SETTING_HINT}>{t('desktop.ai.loading')}</p>

  const set = (patch: Partial<Settings>): void => setSettings({ ...settings, ...patch })

  const save = async (): Promise<void> => {
    const problem = validateSettings(settings)
    if (problem) return toast('error', problem)
    setBusy('save')
    try {
      await saveAiSettings(settings)
      toast('success', t('desktop.ai.saved'))
    } catch (e) {
      toast('error', String(e))
    } finally {
      setBusy('')
    }
  }

  const test = async (): Promise<void> => {
    setBusy('test')
    try {
      // The real client against the real endpoint: anything less proves the
      // form is filled in, not that the provider answers.
      const client = createClient(resolveConfig(settings))
      const out = await client.complete({
        // Not translated: this is sent to a model, not shown to anyone.
        system: 'You are a terse assistant.',
        user: 'Reply with one word: OK',
      })
      toast('success', t('desktop.ai.reachableWith', { reply: out.slice(0, 40) }))
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const loadModelList = async (): Promise<void> => {
    setBusy('models')
    try {
      setModels(await listModels(resolveConfig(settings)))
    } catch (e) {
      // A provider that publishes no catalogue is normal, not broken — the
      // preset's hand-kept list stands in and the field stays free text.
      setModels(preset.models ?? [])
      toast('info', (e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <section className={SETTING_ROW}>
        <div>
          <h2>{t('desktop.ai.title')}</h2>
          <p className={SETTING_HINT}>{t('desktop.ai.intro')}</p>
        </div>
        <Select
          className="w-[260px] flex-none"
          label={t('desktop.ai.provider')}
          value={settings.provider}
          options={PROVIDERS.map(([id, p]) => ({ value: id, label: p.label }))}
          onChange={(v) => setSettings(switchProvider(settings, v as ProviderId))}
        />
      </section>

      {preset.needsSignIn && (
        <section className={SETTING_ROW}>
          <div>
            <h2>{t('desktop.ai.signIn')}</h2>
            {/* Said plainly rather than shipped half-done: the flow opens a
                browser and needs the redirect pasted back, and that belongs in
                one piece of work with its own testing. */}
            <p className={SETTING_HINT}>{t('desktop.ai.signInUnavailable')}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void invoke('open_external', { url: 'https://github.com/suiflex/companion' })}
          >
            <ExternalLink />
            {t('desktop.ai.readMore')}
          </Button>
        </section>
      )}

      {settings.provider !== 'builtin' && !preset.needsSignIn && (
        <section className={SETTING_ROW}>
          <div>
            <h2>{preset.needsKey ? t('desktop.ai.apiKey') : t('desktop.ai.apiKeyOptional')}</h2>
            <p className={SETTING_HINT}>{t('desktop.ai.keychainHint')}</p>
          </div>
          <Input
            className="w-[260px] flex-none"
            type="password"
            autoComplete="off"
            value={settings.apiKey}
            placeholder={preset.needsKey ? 'sk-…' : ''}
            onChange={(e) => set({ apiKey: e.target.value })}
          />
        </section>
      )}

      {(preset.needsBaseUrl || settings.baseUrl) && (
        <section className={SETTING_ROW}>
          <div>
            <h2>{t('desktop.ai.baseUrl')}</h2>
            <p className={SETTING_HINT}>{preset.baseUrl || 'https://your-endpoint/v1'}</p>
          </div>
          <Input
            className="w-[260px] flex-none"
            type="url"
            value={settings.baseUrl}
            placeholder={preset.baseUrl}
            onChange={(e) => set({ baseUrl: e.target.value })}
          />
        </section>
      )}

      {settings.provider !== 'builtin' && (
        <section className={SETTING_ROW}>
          <div>
            <h2>{t('desktop.ai.model')}</h2>
            <p className={SETTING_HINT}>
              {models.length
                ? t('desktop.ai.modelsAvailable', { count: models.length })
                : t('desktop.ai.modelsPrompt')}
            </p>
            {showsAsChips(models) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={cn(
                      'rounded-full border bg-sunken px-2.5 py-0.5 text-xs text-muted-foreground hover:border-muted-foreground hover:text-foreground',
                      m === settings.model && 'border-primary text-primary hover:border-primary hover:text-primary',
                    )}
                    aria-pressed={m === settings.model}
                    onClick={() => set({ model: m })}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-none items-center gap-2">
            <Input
              className="w-[260px] flex-none"
              list="desktop-model-options"
              value={settings.model}
              placeholder={preset.model}
              onChange={(e) => set({ model: e.target.value })}
            />
            <datalist id="desktop-model-options">
              {(models.length ? models : (preset.models ?? [])).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <Button type="button" variant="outline" size="sm" disabled={busy !== ''} onClick={() => void loadModelList()}>
              <RefreshCw className={cn(busy === 'models' && 'animate-spin')} />
              {busy === 'models' ? t('desktop.ai.loadingModels') : t('desktop.ai.loadModels')}
            </Button>
          </div>
        </section>
      )}

      <section className={SETTING_ROW}>
        <div>
          <h2>{t('desktop.ai.check')}</h2>
          <p className={SETTING_HINT}>{t('desktop.ai.checkHint')}</p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy !== ''} onClick={() => void test()}>
            <PlugZap />
            {busy === 'test' ? t('desktop.ai.testing') : t('desktop.ai.test')}
          </Button>
          <Button type="button" size="sm" disabled={busy !== ''} onClick={() => void save()}>
            <Save />
            {t('desktop.ai.save')}
          </Button>
        </div>
      </section>
    </>
  )
}
