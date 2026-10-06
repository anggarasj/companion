// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@meetcc/shared/i18n'
import { VaultList } from './VaultList'
import type { VaultEntry } from './vaults'

afterEach(cleanup)

const LIST: VaultEntry[] = [
  { id: 'a', name: 'Work', path: '/Users/x/notes-2026', hidden: false },
  { id: 'b', name: 'Personal', path: '/Users/x/personal', hidden: false },
  { id: 'c', name: 'Archive', path: '/Users/x/old', hidden: true },
]

function mount(root = '/Users/x/notes-2026') {
  const onOpen = vi.fn()
  const onChange = vi.fn()
  render(<VaultList vaults={LIST} root={root} onOpen={onOpen} onAdd={() => {}} onChange={onChange} />)
  return { onOpen, onChange }
}

describe('VaultList', () => {
  it('lists visible vaults by their own names and opens another', () => {
    const { onOpen } = mount()
    expect(screen.getByText('Work')).toBeTruthy()
    expect(screen.queryByText('Archive')).toBeNull()
    fireEvent.click(screen.getByText('Personal'))
    expect(onOpen).toHaveBeenCalledWith(LIST[1])
    fireEvent.click(screen.getByText('Work')) // already open: nothing
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('renames inline without touching the path', () => {
    const { onChange } = mount()
    fireEvent.doubleClick(screen.getByText('Personal'))
    const input = screen.getByRole('textbox', { name: t('desktop.vaults.rename') })
    fireEvent.change(input, { target: { value: 'Rumah' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onChange.mock.calls.at(-1)![0][1]).toEqual({ ...LIST[1], name: 'Rumah' })
  })

  it('hides a vault, and shows hidden ones on request', () => {
    const { onChange } = mount()
    const hide = screen.getAllByRole('button', { name: t('desktop.vaults.hide') })
    expect(hide).toHaveLength(1) // the open vault cannot be hidden
    fireEvent.click(hide[0])
    expect(onChange.mock.calls[0][0][1].hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: t('desktop.vaults.showHidden', { count: 1 }) }))
    expect(screen.getByText('Archive')).toBeTruthy()
  })
})
