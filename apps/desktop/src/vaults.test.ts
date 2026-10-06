// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { addVault, isCurrent, loadVaults, removeVault, renameVault, saveVaults, setHidden, withCurrent } from './vaults'

beforeEach(() => localStorage.clear())

describe('vault list', () => {
  it('names a new vault after its folder, and lists a folder once', () => {
    let list = addVault([], '/Users/a/Documents/notes-2026/')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'notes-2026', path: '/Users/a/Documents/notes-2026', hidden: false })
    list = addVault(list, '/Users/a/Documents/notes-2026')
    expect(list).toHaveLength(1)
  })

  it('a name is a label, independent of the folder', () => {
    const one = addVault([], '/x/notes-2026')
    expect(renameVault(one, one[0].id, '  Work  ')[0]).toMatchObject({ name: 'Work', path: '/x/notes-2026' })
    expect(renameVault(one, one[0].id, '   ')[0].name).toBe('notes-2026')
  })

  it('hiding keeps the vault; the open one is never hidden', () => {
    const list = addVault(addVault([], '/a'), '/b')
    const hidden = setHidden(list, list[1].id, true)
    expect(hidden[1].hidden).toBe(true)
    expect(withCurrent(hidden, '/b')[1].hidden).toBe(false)
    expect(withCurrent(hidden, '/c').map((v) => v.path)).toEqual(['/a', '/b', '/c'])
  })

  it('removing forgets the entry only', () => {
    const list = addVault(addVault([], '/a'), '/b')
    expect(removeVault(list, list[0].id).map((v) => v.path)).toEqual(['/b'])
  })

  it('persists, and survives a corrupt store', () => {
    saveVaults(addVault([], '/a'))
    expect(loadVaults()[0].path).toBe('/a')
    localStorage.setItem('companion:vaults', '{"oops":1}')
    expect(loadVaults()).toEqual([])
    localStorage.setItem('companion:vaults', '[{"id":1}]')
    expect(loadVaults()).toEqual([])
  })

  it('matches the open root across a trailing slash', () => {
    expect(isCurrent(addVault([], '/a/b')[0], '/a/b/')).toBe(true)
  })
})
