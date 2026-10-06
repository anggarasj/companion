// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadPanes, savePanes } from './panes'

beforeEach(() => localStorage.clear())

describe('panes', () => {
  it('opens with both left panes shown and the AI panel closed', () => {
    expect(loadPanes()).toEqual({ vaults: true, files: true, ai: false })
  })

  it('remembers each pane on its own', () => {
    savePanes({ vaults: false, files: true, ai: true })
    expect(loadPanes()).toEqual({ vaults: false, files: true, ai: true })
  })

  it('ignores a corrupt value', () => {
    localStorage.setItem('companion:panes', '{"vaults":"no"}')
    expect(loadPanes().vaults).toBe(true)
    localStorage.setItem('companion:panes', 'nope')
    expect(loadPanes()).toEqual({ vaults: true, files: true, ai: false })
  })
})
