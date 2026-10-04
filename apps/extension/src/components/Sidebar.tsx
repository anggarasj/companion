import { useEffect, useMemo, useState } from 'react'
import {
  displayMeetingId,
  isLive,
  startedAt,
  type AnalysisRecord,
  type Meeting,
} from '@meetcc/shared'

import { listProjects, listSessions } from '../lib/db'
import { activeSponsorLinks } from '../lib/sponsor'
import { resolveTheme, watchSystemTheme, type ThemePref } from '../lib/theme'
import { locale, t } from '@meetcc/shared/i18n'
import { Button } from '@meetcc/ui'

const themeLabel = (p: ThemePref): string =>
  t('ext.sidebar.theme', {
    mode: p === 'system' ? t('pref.system') : p === 'light' ? t('pref.light') : t('pref.dark'),
  })

const THEME_ICON: Record<ThemePref, string> = {
  system: '◐',
  light: '☀',
  dark: '☾',
}

const NEXT: Record<ThemePref, ThemePref> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

/** Cycles system → light → dark; persisted so the next open keeps the choice. */
function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>('system')

  // main.tsx already stamped the resolved theme before first paint; this only
  // recovers which *preference* produced it, so the cycle starts where the
  // user left off rather than always at `system`.
  useEffect(() => {
    void chrome.storage.local
      .get('theme')
      .then(({ theme }) => {
        if (theme === 'light' || theme === 'dark' || theme === 'system') setPref(theme)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    document.body.dataset.theme = resolveTheme(pref)
    try {
      void chrome.storage.local.set({ theme: pref })
    } catch {
      /* storage unavailable — theme still applies for this session */
    }
    if (pref !== 'system') return
    // Follow the OS live, not just on the next open.
    return watchSystemTheme((t) => {
      document.body.dataset.theme = t
    })
  }, [pref])

  return (
    <Button className='icon-btn'
    onClick={() => setPref((p) => NEXT[p])}
    aria-label={themeLabel(pref)}
    title={themeLabel(pref)}>{THEME_ICON[pref]}</Button>
  )
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return (
    d.toLocaleDateString(locale(), { day: '2-digit', month: 'short' }) +
    ' · ' +
    d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  )
}

interface Props {
  meetings: Meeting[]
  loading: boolean
  records: Record<string, AnalysisRecord>
  titles: Record<string, string>
  now: number
  selectedId: string | null
  activeView: 'meeting' | 'knowledge' | 'decisions' | 'settings'
  onSelect: (id: string) => void
  onSettings: () => void
  onDecisions: () => void
  onKnowledge: () => void
  onSearch: () => void
  onDelete: (id: string) => void
  onExportMeetings: (ids: string[]) => Promise<string[]>
  onDeleteMeetings: (ids: string[]) => Promise<string[] | null>
  onMergeMeetings: (ids: string[], targetId: string) => Promise<boolean>
}

export function Sidebar({
  meetings,
  loading,
  records,
  titles,
  now,
  selectedId,
  activeView,
  onSelect,
  onSettings,
  onDecisions,
  onKnowledge,
  onSearch,
  onDelete,
  onExportMeetings,
  onDeleteMeetings,
  onMergeMeetings,
}: Props) {
  const [open, setOpen] = useState(true)
  const [selecting, setSelecting] = useState(false)
  const [selectedMeetings, setSelectedMeetings] = useState<Set<string>>(() => new Set())
  const [exporting, setExporting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeTarget, setMergeTarget] = useState('')
  // P2.3 — project grouping. The mapping lives in the index, so a failed load
  // just means the filter is unavailable, never an empty meeting list.
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [projectOf, setProjectOf] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let alive = true
    void Promise.all([listProjects(), listSessions()])
      .then(([p, sessions]) => {
        if (!alive) return
        setProjects(p)
        setProjectOf(
          Object.fromEntries(
            sessions.filter((s) => s.projectId).map((s) => [s.id, s.projectId as string]),
          ),
        )
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [meetings.length])
  useEffect(() => {
    const currentIds = new Set(meetings.map((m) => m.id))
    setSelectedMeetings((current) => {
      const next = new Set([...current].filter((id) => currentIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [meetings])

  const shown = useMemo(
    () => (filter ? meetings.filter((m) => projectOf[m.id] === filter) : meetings),
    [meetings, filter, projectOf],
  )
  const live = shown.filter((m) => isLive(m, now))
  const allVisibleSelected = shown.length > 0 && shown.every((m) => selectedMeetings.has(m.id))
  const toggleMeeting = (id: string, checked: boolean) => {
    setSelectedMeetings((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const toggleVisibleMeetings = () => {
    setSelectedMeetings((current) => {
      const next = new Set(current)
      const clearVisible = shown.length > 0 && shown.every((m) => current.has(m.id))
      for (const m of shown) {
        if (clearVisible) next.delete(m.id)
        else next.add(m.id)
      }
      return next
    })
  }
  const cancelSelection = () => {
    setSelecting(false)
    setSelectedMeetings(new Set())
  }
  const selectedForMerge = meetings.filter((meeting) => selectedMeetings.has(meeting.id))
  const defaultMergeTarget = selectedMeetings.has(selectedId ?? '')
    ? selectedId!
    : selectedForMerge[0]?.id ?? ''
  const mergeTargetId = selectedMeetings.has(mergeTarget) ? mergeTarget : defaultMergeTarget
  const mergeSourcesLive = selectedForMerge.some(
    (meeting) => meeting.id !== mergeTargetId && isLive(meeting, now),
  )
  const mergeSelected = async () => {
    if (selectedForMerge.length < 2 || !mergeTargetId || mergeSourcesLive || merging) return
    setMerging(true)
    try {
      if (await onMergeMeetings([...selectedMeetings], mergeTargetId)) cancelSelection()
    } finally {
      setMerging(false)
    }
  }
  const transferSelected = async () => {
    if (!selectedMeetings.size || exporting || deleting || merging) return
    setExporting(true)
    try {
      const failedIds = await onExportMeetings([...selectedMeetings])
      setSelectedMeetings(new Set(failedIds))
      if (!failedIds.length) setSelecting(false)
    } finally {
      setExporting(false)
    }
  }
  const deleteSelected = async () => {
    if (!selectedMeetings.size || exporting || deleting || merging) return
    setDeleting(true)
    try {
      const failedIds = await onDeleteMeetings([...selectedMeetings])
      if (failedIds === null) return
      setSelectedMeetings(new Set(failedIds))
      if (!failedIds.length) setSelecting(false)
    } finally {
      setDeleting(false)
    }
  }
  const past = shown.filter((m) => !isLive(m, now))

  const badge = (m: Meeting) => {
    const r = records[m.id]
    if (!r) return null
    if (r.status === 'processing')
      return <span className='ai-badge processing'>AI…</span>
    if (r.status === 'error') return <span className='ai-badge error'>!</span>
    return <span className='ai-badge done'>✓</span>
  }

  const item = (m: Meeting) => {
    // named by the AI summary (or the user); falls back to the raw meeting id
    const label = titles[m.id] || displayMeetingId(m.id)
    return (
    <div key={m.id} className='meeting-row'>
      {selecting && (
        <input
          className='meeting-select'
          type='checkbox'
          aria-label={t('ext.sidebar.selectMeeting', { label })}
          checked={selectedMeetings.has(m.id)}
          disabled={exporting || deleting || merging}
          onChange={(event) => toggleMeeting(m.id, event.target.checked)}
        />
      )}
      <Button className={`meeting ${m.id === selectedId ? 'selected' : ''}`}
      title={m.id}
      onClick={() => onSelect(m.id)}><span className={`status ${isLive(m, now) ? 'on' : ''}`} />
      <span className='meeting-body'>
        <span className='meeting-id'>{label}</span>
        <span className='meeting-sub'>
          {fmtDate(startedAt(m))} · {t('ext.sidebar.lines', { count: m.entries.length })}
        </span>
      </span>
      {badge(m)}</Button>
      <Button className='meeting-del'
      aria-label={t('ext.sidebar.deleteMeeting', { label })}
      title={t('ext.sidebar.deleteMeetingHint')}
      onClick={() => onDelete(m.id)}>
      🗑
            </Button>
    </div>
    )
  }

  // collapsed: slim icon rail — every action stays reachable, zero clutter
  if (!open) {
    return (
      <aside className='sidebar collapsed'>
        <Button className='icon-btn'
        onClick={() => setOpen(true)}
        aria-label={t('ext.sidebar.expand')}
        aria-expanded='false'
        title={t('ext.sidebar.expand')}>
        »
                </Button>
        <img className='brand-logo' src='icons/suiflex.svg' alt='Suiflex' />
        {live.length > 0 && (
          <span
            className='rail-live'
            title={t('ext.sidebar.liveCount', { count: live.length })}
          />
        )}
        <span className='spacer' />
        <Button className='icon-btn'
        onClick={onSearch}
        aria-label={t('ext.sidebar.searchAll')}
        title={t('ext.sidebar.searchAllShortcut')}>
        ⌕
                </Button>
        <Button className={`icon-btn ${activeView === 'knowledge' ? 'active' : ''}`}
        onClick={onKnowledge}
        aria-label={t('ext.sidebar.knowledge')}
        title={t('ext.sidebar.knowledge')}>
        ✦
                </Button>
        <Button className={`icon-btn ${activeView === 'decisions' ? 'active' : ''}`}
        onClick={onDecisions}
        aria-label={t('ext.sidebar.decisions')}
        title={t('ext.sidebar.decisions')}>
        ▤
                </Button>
        <ThemeToggle />
        <Button className={`icon-btn ${activeView === 'settings' ? 'active' : ''}`}
        onClick={onSettings}
        aria-label={t('ext.sidebar.settings')}
        title={t('ext.sidebar.settings')}>
        ⚙
                </Button>
      </aside>
    )
  }

  return (
    <aside className='sidebar'>
      <div className='sidebar-top'>
        <div className='brand'>
          <img className='brand-logo' src='icons/suiflex.svg' alt='Suiflex' />
          <span className='brand-name'>Companion</span>
          <Button className='icon-btn collapse-btn'
          onClick={() => setOpen(false)}
          aria-label={t('ext.sidebar.collapse')}
          aria-expanded='true'
          title={t('ext.sidebar.collapse')}>
          «
                    </Button>
        </div>

        <Button className='sidebar-search-btn'
        onClick={onSearch}
        aria-label={t('ext.sidebar.searchAll')}
        title={t('ext.sidebar.searchAllShortcut')}><span className='sidebar-search-icon'>⌕</span>
        <span className='sidebar-search-text'>{t('ext.sidebar.searchAll')}</span>
        <kbd className='sidebar-search-kbd'>⌘K</kbd></Button>

        <nav className='sidebar-nav' aria-label={t('ext.sidebar.knowledge')}>
          <Button className={`sidebar-nav-btn ${activeView === 'knowledge' ? 'active' : ''}`}
          onClick={onKnowledge}
          title={t('ext.sidebar.knowledge')}><span className='sidebar-nav-icon'>✦</span>
          <span className='sidebar-nav-label'>{t('ext.sidebar.knowledge')}</span></Button>
          <Button className={`sidebar-nav-btn ${activeView === 'decisions' ? 'active' : ''}`}
          onClick={onDecisions}
          title={t('ext.sidebar.decisions')}><span className='sidebar-nav-icon'>▤</span>
          <span className='sidebar-nav-label'>{t('ext.sidebar.decisions')}</span></Button>
        </nav>
      </div>

      <div className='sidebar-scroll'>
        {projects.length > 0 && (
          <label className='sidebar-filter'>
            <span className='section-label'>{t('ext.sidebar.project')}</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('ext.sidebar.projectFilter')}>
              <option value=''>{t('ext.sidebar.allMeetings')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className='meeting-bulk'>
          <div className='meeting-bulk-row'>
            <Button
              type='button'
              variant={selecting ? 'ghost' : 'default'}
              disabled={loading || meetings.length === 0 || exporting || deleting || merging}
              aria-pressed={selecting}
              onClick={() => selecting ? cancelSelection() : setSelecting(true)}
            >
              {selecting ? t('ext.sidebar.cancelMeetingSelection') : t('ext.sidebar.selectMeetings')}
            </Button>
            {selecting && (
              <Button
                type='button'
                variant='ghost'
                disabled={shown.length === 0 || exporting || deleting || merging}
                onClick={toggleVisibleMeetings}
              >
                {allVisibleSelected ? t('ext.sidebar.clearVisibleSelection') : t('ext.sidebar.selectVisibleMeetings')}
              </Button>
            )}
          </div>
          {selecting && (
            <>
              <div className='meeting-bulk-row'>
                <span className='meeting-selection-count'>
                  {t('ext.sidebar.selectedMeetingCount', { count: selectedMeetings.size })}
                </span>
                <Button
                  type='button'
                  variant='primary'
                  disabled={!selectedMeetings.size || exporting || deleting || merging}
                  onClick={() => void transferSelected()}
                >
                  {exporting
                    ? t('ext.sidebar.sendingMeetingsToDesktop')
                    : t('ext.sidebar.sendMeetingsToDesktop', { count: selectedMeetings.size })}
                </Button>
                <Button
                  type='button'
                  variant='danger'
                  disabled={!selectedMeetings.size || exporting || deleting || merging}
                  onClick={() => void deleteSelected()}
                >
                  {deleting
                    ? t('ext.sidebar.deletingMeetings')
                    : t('ext.sidebar.deleteSelectedMeetings', { count: selectedMeetings.size })}
                </Button>
              </div>
              {selectedMeetings.size > 1 && (
                <>
                  <label className='meeting-merge-target'>
                    <span>{t('ext.sidebar.mergeTarget')}</span>
                    <select
                      value={mergeTargetId}
                      disabled={exporting || deleting || merging}
                      onChange={(event) => setMergeTarget(event.target.value)}
                    >
                      {selectedForMerge.map((meeting) => (
                        <option key={meeting.id} value={meeting.id}>
                          {titles[meeting.id] || displayMeetingId(meeting.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {mergeSourcesLive && (
                    <p className='meeting-merge-warning'>{t('ext.sidebar.liveSourceMergeBlocked')}</p>
                  )}
                  <Button
                    type='button'
                    variant='primary'
                    disabled={selectedForMerge.length < 2 || mergeSourcesLive || exporting || deleting || merging}
                    onClick={() => void mergeSelected()}
                  >
                    {merging
                      ? t('ext.sidebar.mergingMeetings')
                      : t('ext.sidebar.mergeSelectedMeetings', { count: selectedForMerge.length })}
                  </Button>
                </>
              )}
            </>
          )}
        </div>
        {loading ? (
          <div aria-hidden='true'>
            {[0, 1, 2].map((i) => (
              <div key={i} className='skeleton skeleton-row' />
            ))}
          </div>
        ) : (
          <>
            {live.length > 0 && (
              <section className='meeting-section'>
                <h2 className='section-label'>{t('ext.sidebar.live')}</h2>
                {live.map(item)}
              </section>
            )}
            <section className='meeting-section'>
              <h2 className='section-label'>{t('ext.sidebar.history')}</h2>
              {past.length ? (
                past.map(item)
              ) : (
                <p className='section-empty'>{t('ext.sidebar.historyEmpty')}</p>
              )}
            </section>
          </>
        )}
      </div>

      <div className='sidebar-bottom'>
        <div className='sidebar-foot'>
          <ThemeToggle />
          <Button className={`icon-btn ${activeView === 'settings' ? 'active' : ''}`}
          onClick={onSettings}
          aria-label={t('ext.sidebar.settings')}
          title={t('ext.sidebar.settings')}>
          ⚙
                    </Button>
          <span className='spacer' />
          {activeSponsorLinks().map((link) => (
            <a
              key={link.id}
              className='icon-btn'
              href={link.url}
              target='_blank'
              rel='noreferrer noopener'
              aria-label={`${t('sponsor.title')} · ${t(link.label)}`}
              title={`${t('sponsor.title')} · ${t(link.label)}`}>
              {link.icon}
            </a>
          ))}
        </div>
        <p className='sidebar-credit'>
          <img className='credit-logo' src='icons/suiflex.svg' alt='' />
          powered by suiflex
        </p>
      </div>
    </aside>
  )
}
