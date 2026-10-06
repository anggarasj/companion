import { describe, expect, it } from 'vitest'
import { lineDiff } from './diff'

describe('lineDiff', () => {
  it('marks an appended section as added and keeps the rest', () => {
    const d = lineDiff('# PRD\n\nIntro', '# PRD\n\nIntro\n\n## Security\n\n- TLS')
    expect(d.filter((l) => l.kind === 'same').map((l) => l.text)).toEqual(['# PRD', '', 'Intro'])
    expect(d.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['', '## Security', '', '- TLS'])
    expect(d.some((l) => l.kind === 'del')).toBe(false)
  })

  it('a rewritten line is one removal and one addition', () => {
    expect(lineDiff('a\nold\nc', 'a\nnew\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'same', text: 'c' },
    ])
  })

  it('an empty document becomes all additions', () => {
    expect(lineDiff('', '# Doc\n\nBody')).toEqual([
      { kind: 'add', text: '# Doc' },
      { kind: 'add', text: '' },
      { kind: 'add', text: 'Body' },
    ])
  })
})
