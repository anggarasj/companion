import { useState, type KeyboardEvent } from 'react'
import { t, LANGS, type LangPref, type MessageKey } from '@meetcc/shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/Segmented'
import { SETTING_HINT, SETTING_ROW } from '@/components/settingStyles'
import { AIProviderPanel } from './AIProviderPanel'
import { InstallView } from './InstallView'
import { VersionPanel } from './VersionPanel'
import { langLabel, themeLabel } from './preferenceLabels'
import type { ThemePref } from './theme'

export interface SettingsPageProps {
  root: string
  noteCount: number
  onMove: () => void
  onReset: () => void
  isDefaultRoot: boolean
  themePref: ThemePref
  onThemeChange: (pref: ThemePref) => void
  langPref: LangPref
  onLangChange: (pref: LangPref) => void
  autosave: boolean
  onAutosaveChange: (on: boolean) => void
}

// Keys, not labels: resolved at render so a language switch relabels the nav.
const SECTIONS = {
  general: 'desktop.settings.section.general',
  editor: 'desktop.settings.section.editor',
  vault: 'desktop.settings.section.vault',
  browsers: 'desktop.settings.section.browsers',
  ai: 'desktop.settings.section.ai',
  version: 'desktop.settings.section.version',
} satisfies Record<string, MessageKey>

type Section = keyof typeof SECTIONS
const ORDER = Object.keys(SECTIONS) as Section[]

export function SettingsPage({
  root,
  noteCount,
  onMove,
  onReset,
  isDefaultRoot,
  themePref,
  onThemeChange,
  langPref,
  onLangChange,
  autosave,
  onAutosaveChange,
}: SettingsPageProps) {
  const [section, setSection] = useState<Section>('general')

  // Arrow keys move between sections, the way a vertical tab list reads.
  const onNavKey = (e: KeyboardEvent<HTMLElement>): void => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = ORDER[(ORDER.indexOf(section) + step + ORDER.length) % ORDER.length]
    setSection(next)
    document.getElementById(`settings-tab-${next}`)?.focus()
  }

  return (
    <div className="grid h-full grid-cols-[200px_minmax(0,1fr)]">
      <nav
        className="flex flex-col gap-0.5 border-r bg-card px-3 py-7"
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('desktop.settings.title')}
        onKeyDown={onNavKey}
      >
        {ORDER.map((key) => (
          <button
            key={key}
            id={`settings-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={section === key}
            aria-controls="settings-panel"
            tabIndex={section === key ? 0 : -1}
            className={cn(
              'rounded-md px-3 py-[7px] text-left text-[13px] font-medium leading-snug text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary',
              section === key && 'bg-primary/12 font-semibold text-primary hover:bg-primary/12 hover:text-primary',
            )}
            onClick={() => setSection(key)}
          >
            {t(SECTIONS[key])}
          </button>
        ))}
      </nav>

      <div
        className="overflow-y-auto px-9 pb-10 pt-7 *:max-w-[640px]"
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${section}`}
      >
        <h1 className="mb-5 mt-0 text-xl font-semibold">{t(SECTIONS[section])}</h1>

        {section === 'general' && (
          <>
            <section className={SETTING_ROW}>
              <div>
                <h2>{t('desktop.settings.language')}</h2>
                <p className={SETTING_HINT}>{t('desktop.settings.languageHint')}</p>
              </div>
              <Segmented
                ariaLabel={t('desktop.settings.language')}
                options={(['system', ...LANGS] as LangPref[]).map((pref) => ({
                  value: pref,
                  label: langLabel(pref),
                }))}
                value={langPref}
                onChange={(value) => onLangChange(value as LangPref)}
              />
            </section>

            <section className={SETTING_ROW}>
              <div>
                <h2>{t('desktop.settings.theme')}</h2>
                <p className={SETTING_HINT}>{t('desktop.settings.themeHint')}</p>
              </div>
              <Segmented
                ariaLabel={t('desktop.settings.theme')}
                options={(['system', 'light', 'dark'] as ThemePref[]).map((pref) => ({
                  value: pref,
                  label: themeLabel(pref),
                }))}
                value={themePref}
                onChange={(value) => onThemeChange(value as ThemePref)}
              />
            </section>
          </>
        )}

        {section === 'editor' && (
          <section className={SETTING_ROW}>
            <div>
              <h2>{t('desktop.settings.autosave')}</h2>
              <p className={SETTING_HINT}>{t('desktop.settings.autosaveHint')}</p>
            </div>
            <Segmented
              ariaLabel={t('desktop.settings.autosave')}
              options={[
                { value: 'on', label: t('pref.on') },
                { value: 'off', label: t('pref.off') },
              ]}
              value={autosave ? 'on' : 'off'}
              onChange={(value) => onAutosaveChange(value === 'on')}
            />
          </section>
        )}

        {section === 'vault' && (
          <>
            <section className={SETTING_ROW}>
              <div>
                <h2>{t('desktop.settings.vaultLocation')}</h2>
                <p className="m-0 font-mono text-xs leading-normal wrap-anywhere text-primary">{root}</p>
                <p className={SETTING_HINT}>{t('desktop.settings.vaultHint', { count: noteCount })}</p>
              </div>
              <div className="flex flex-none items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={onMove}>
                  {t('desktop.settings.moveVault')}
                </Button>
                {!isDefaultRoot && (
                  <Button type="button" variant="outline" size="sm" onClick={onReset}>
                    {t('desktop.settings.resetVault')}
                  </Button>
                )}
              </div>
            </section>

            <section className={SETTING_ROW}>
              <div>
                <h2>{t('desktop.settings.index')}</h2>
                <p className={SETTING_HINT}>{t('desktop.settings.indexHint')}</p>
              </div>
            </section>
          </>
        )}

        {section === 'browsers' && (
          <>
            <section className={SETTING_ROW}>
              <div>
                <h2>{t('desktop.settings.bridge')}</h2>
                <p className={SETTING_HINT}>{t('desktop.settings.bridgeHint')}</p>
              </div>
            </section>
            <InstallView />
          </>
        )}

        {section === 'ai' && <AIProviderPanel />}

        {section === 'version' && <VersionPanel />}
      </div>
    </div>
  )
}
