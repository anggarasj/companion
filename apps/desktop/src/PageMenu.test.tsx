// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@meetcc/shared/i18n'
import { PageMenu } from './PageMenu'

afterEach(cleanup)

describe('PageMenu', () => {
  it('keeps trash one click away now that the action bar is gone', () => {
    const trash = vi.fn()
    render(<PageMenu actions={[{ id: 'trash', label: t('desktop.editor.trash'), danger: true, run: trash }]} />)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('desktop.page.menu') }))
    fireEvent.click(screen.getByRole('menuitem', { name: t('desktop.editor.trash') }))
    expect(trash).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes on Escape without acting', () => {
    const trash = vi.fn()
    render(<PageMenu actions={[{ id: 'trash', label: 'x', run: trash }]} />)
    fireEvent.click(screen.getByRole('button', { name: t('desktop.page.menu') }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trash).not.toHaveBeenCalled()
  })
})
