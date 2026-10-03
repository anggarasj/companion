// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisRecord, Meeting } from '@meetcc/shared'
import { t } from '@meetcc/shared/i18n'
import { Sidebar } from './Sidebar'

vi.mock('../lib/db', () => ({
  listProjects: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
}))
vi.mock('../lib/sponsor', () => ({ activeSponsorLinks: () => [] }))

const meetings: Meeting[] = [
  {
    id: 'project-sync-1',
    meta: { id: 'project-sync-1', startedAt: '2026-09-20T10:00:00Z', lastSeenAt: '2026-09-20T10:30:00Z' },
    entries: [{ speaker: 'Rani', text: 'Bahas roadmap.', time: '2026-09-20T10:10:00Z' }],
  },
  {
    id: 'project-sync-2',
    meta: { id: 'project-sync-2', startedAt: '2026-09-21T10:00:00Z', lastSeenAt: '2026-09-21T10:30:00Z' },
    entries: [{ speaker: 'Dimas', text: 'Review milestone.', time: '2026-09-21T10:10:00Z' }],
  },
]

function renderSidebar(
  onExportMeetings: (ids: string[]) => Promise<string[]>,
  onDeleteMeetings: (ids: string[]) => Promise<string[] | null> = async () => [],
) {
  return render(
    <Sidebar
      meetings={meetings}
      loading={false}
      records={{} as Record<string, AnalysisRecord>}
      titles={{ 'project-sync-1': 'Project Sync 1', 'project-sync-2': 'Project Sync 2' }}
      now={Date.parse('2026-09-22T10:00:00Z')}
      selectedId={null}
      activeView='meeting'
      onSelect={vi.fn()}
      onSettings={vi.fn()}
      onDecisions={vi.fn()}
      onKnowledge={vi.fn()}
      onSearch={vi.fn()}
      onDelete={vi.fn()}
      onExportMeetings={onExportMeetings}
      onDeleteMeetings={onDeleteMeetings}
    />,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('sidebar multi-meeting export', () => {
  it('retries only failed meetings after a partial desktop transfer', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    })
    const onExportMeetings = vi.fn()
      .mockResolvedValueOnce(['project-sync-2'])
      .mockResolvedValueOnce([])
    const user = userEvent.setup()
    renderSidebar(onExportMeetings)

    await user.click(screen.getByRole('button', { name: t('ext.sidebar.selectMeetings') }))
    await user.click(screen.getByRole('checkbox', { name: /Project Sync 1/ }))
    await user.click(screen.getByRole('checkbox', { name: /Project Sync 2/ }))
    await user.click(screen.getByRole('button', { name: t('ext.sidebar.sendMeetingsToDesktop', { count: 2 }) }))

    await waitFor(() => expect(onExportMeetings).toHaveBeenCalledTimes(1))
    expect(onExportMeetings).toHaveBeenNthCalledWith(1, ['project-sync-1', 'project-sync-2'])
    expect((screen.getByRole('checkbox', { name: /Project Sync 1/ }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: /Project Sync 2/ }) as HTMLInputElement).checked).toBe(true)

    await user.click(screen.getByRole('button', { name: t('ext.sidebar.sendMeetingsToDesktop', { count: 1 }) }))
    await waitFor(() => expect(onExportMeetings).toHaveBeenCalledTimes(2))
    expect(onExportMeetings).toHaveBeenNthCalledWith(2, ['project-sync-2'])
    expect(screen.queryByRole('checkbox', { name: /Project Sync/ })).toBeNull()
  })
  it('retries only undeleted meetings after a partial bulk delete', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    })
    const onDeleteMeetings = vi.fn()
      .mockResolvedValueOnce(['project-sync-2'])
      .mockResolvedValueOnce([])
    const user = userEvent.setup()
    renderSidebar(vi.fn(async () => []), onDeleteMeetings)

    await user.click(screen.getByRole('button', { name: t('ext.sidebar.selectMeetings') }))
    await user.click(screen.getByRole('checkbox', { name: /Project Sync 1/ }))
    await user.click(screen.getByRole('checkbox', { name: /Project Sync 2/ }))
    await user.click(screen.getByRole('button', { name: t('ext.sidebar.deleteSelectedMeetings', { count: 2 }) }))

    await waitFor(() => expect(onDeleteMeetings).toHaveBeenCalledTimes(1))
    expect(onDeleteMeetings).toHaveBeenNthCalledWith(1, ['project-sync-1', 'project-sync-2'])
    expect((screen.getByRole('checkbox', { name: /Project Sync 1/ }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: /Project Sync 2/ }) as HTMLInputElement).checked).toBe(true)

    await user.click(screen.getByRole('button', { name: t('ext.sidebar.deleteSelectedMeetings', { count: 1 }) }))
    await waitFor(() => expect(onDeleteMeetings).toHaveBeenCalledTimes(2))
    expect(onDeleteMeetings).toHaveBeenNthCalledWith(2, ['project-sync-2'])
    expect(screen.queryByRole('checkbox', { name: /Project Sync/ })).toBeNull()
  })

  it('cancels selection and clears all checked meetings', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    })
    const onExportMeetings = vi.fn(async () => [])
    const user = userEvent.setup()
    renderSidebar(onExportMeetings)

    await user.click(screen.getByRole('button', { name: t('ext.sidebar.selectMeetings') }))
    await user.click(screen.getByRole('checkbox', { name: /Project Sync 1/ }))
    await user.click(screen.getByRole('button', { name: t('ext.sidebar.cancelMeetingSelection') }))

    expect(screen.queryByRole('checkbox', { name: /Project Sync/ })).toBeNull()
    expect(onExportMeetings).not.toHaveBeenCalled()
  })
})
