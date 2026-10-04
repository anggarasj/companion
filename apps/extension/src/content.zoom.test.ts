// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '@meetcc/shared'

const script = readFileSync(join(process.cwd(), 'apps/extension/public/content.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'apps/extension/public/manifest.json'), 'utf8')) as {
  host_permissions: string[]
  content_scripts: { matches: string[] }[]
}

afterEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>'
})

function boot(html: string, url = 'https://us04web.zoom.us/wc/123456789/join', deferSession = false) {
  document.body.innerHTML = html
  const data = new Map<string, unknown>()
  const ticks = new Map<number, () => void>()
  const sent: { type: string; roomId?: string }[] = []
  let finishSession: (() => void) | undefined
  const chrome = {
    storage: {
      local: {
        get: (keys: string | string[], done: (value: Record<string, unknown>) => void) => {
          const result: Record<string, unknown> = {}
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (data.has(key)) result[key] = data.get(key)
          }
          done(result)
        },
        set: (values: Record<string, unknown>, done?: () => void) => {
          for (const [key, value] of Object.entries(values)) data.set(key, value)
          done?.()
        },
      },
      onChanged: { addListener: () => undefined },
    },
    runtime: {
      sendMessage: (msg: { type: string; roomId?: string }, done?: (value: unknown) => void) => {
        sent.push(msg)
        if (msg.type === 'resolve-session' && deferSession) {
          finishSession = () => done?.({ sessionId: `${msg.roomId}#1000` })
        } else {
          done?.(msg.type === 'resolve-session' ? { sessionId: `${msg.roomId}#1000` } : undefined)
        }
      },
    },
  }
  const interval = (fn: () => void, ms: number) => {
    ticks.set(ms, fn)
    return ms
  }
  // content.js ships unbundled. Give it a Zoom URL and chrome API while the
  // real DOM comes from Vitest's jsdom environment.
  new Function('location', 'chrome', 'setInterval', 'console', script)(
    new URL(url), chrome, interval,
    { log: vi.fn(), warn: vi.fn() },
  )
  return {
    sent,
    finishSession: () => finishSession?.(),
    tick: (ms: number) => {
      const fn = ticks.get(ms)
      if (!fn) throw new Error(`no ${ms} ms interval`)
      fn()
    },
    entries: () => data.get('transcript:zm-123456789#1000') as Entry[] | undefined,
  }
}

describe('Zoom Web live captions', () => {
  it('injects on Zoom Web meeting pages with host permission', () => {
    expect(manifest.host_permissions).toContain('https://*.zoom.us/*')
    expect(manifest.content_scripts[0].matches).toContain('https://*.zoom.us/wc/*')
    expect(manifest.content_scripts[0].matches).toContain('https://*.zoom.us/j/*')
  })

  const overlay = `
    <button aria-label="Sembunyikan Teks"><svg class="SvgCaptions"></svg></button>
    <div class="live-transcription-subtitle__overlay-container">
      <div class="live-transcription-subtitle__content">
        <div id="live-transcription-subtitle">
          <img class="zmu-data-selector-item__icon" src="https://example.com/a.png" alt="">
          <span class="live-transcription-subtitle__item">Halo, halo.Halo.</span>
        </div>
        <div id="live-transcription-subtitle">
          <div class="zmu-data-selector-item__icon" style="background-color: rgb(39, 174, 96)">B</div>
          <span class="live-transcription-subtitle__item">Loh, loh. Halo.</span>
        </div>
      </div>
    </div>`

  it('captures each subtitle row into the Zoom room session', () => {
    const app = boot(overlay)
    app.tick(500)
    expect(app.sent).toContainEqual({ type: 'resolve-session', roomId: 'zm-123456789' })
    expect(app.entries()?.map(({ speaker, text }) => [speaker, text])).toEqual([
      ['Speaker 1', 'Halo, halo.Halo.'],
      ['B', 'Loh, loh. Halo.'],
    ])
    app.tick(500)
    expect(app.entries()).toHaveLength(2)
  })

  it('resolves names from the participant list and keeps them after the pane closes', () => {
    const button = `<button aria-label="open the participants list pane,[2] particpants">
      <svg class="SvgParticipants"></svg><span class="footer-button__number-counter">2</span>
    </button>`
    const list = `<div id="participants-unified-list">
      <div class="participants-li">
        <div class="participants-item__avatar" style="background-color: rgb(39, 174, 96)">B</div>
        <span class="participants-item__display-name">Budi</span>
      </div>
      <div class="participants-li">
        <img class="participants-item__avatar" src="https://example.com/a.png">
        <span class="participants-item__display-name">Alya</span>
      </div>
    </div>`
    const app = boot(overlay + button)
    app.tick(500)
    const control = document.querySelector('svg.SvgParticipants')!.closest('button')!
    const click = vi.fn(() => {
      document.body.insertAdjacentHTML('beforeend', list)
      control.setAttribute('aria-label', 'close the participants list pane')
    })
    control.addEventListener('click', click)
    app.tick(3000)
    expect(click).toHaveBeenCalledOnce()
    app.tick(500)
    expect(app.entries()?.map((e) => e.speaker)).toEqual(['Alya', 'Budi'])
    expect(app.entries()).toHaveLength(2)
    document.querySelector('#participants-unified-list')!.remove()
    document.querySelector('.live-transcription-subtitle__content')!.insertAdjacentHTML('beforeend',
      '<div id="live-transcription-subtitle"><div class="zmu-data-selector-item__icon" style="background-color: rgb(39, 174, 96)">B</div><span class="live-transcription-subtitle__item">Kalimat berikutnya.</span></div>')
    app.tick(500)
    expect(app.entries()?.map((e) => e.speaker)).toEqual(['Alya', 'Budi', 'Budi'])
    control.setAttribute('aria-label', 'open the participants list pane,[2] particpants')
    app.tick(3000)
    expect(click).toHaveBeenCalledTimes(2)
  })

  it('does not guess a name when two initial avatars match', () => {
    const people = `<button><svg class="SvgParticipants"></svg><span class="footer-button__number-counter">2</span></button>
      <div id="participants-unified-list">
        <div class="participants-li"><div class="participants-item__avatar" style="background-color: rgb(39, 174, 96)">B</div><span class="participants-item__display-name">Budi</span></div>
        <div class="participants-li"><div class="participants-item__avatar" style="background-color: rgb(39, 174, 96)">B</div><span class="participants-item__display-name">brian</span></div>
      </div>`
    const app = boot(overlay + people)
    app.tick(500)
    expect(app.entries()?.[1].speaker).toBe('B')
  })

  it('does not guess a name when two participants share an avatar image', () => {
    const people = `<button><svg class="SvgParticipants"></svg><span class="footer-button__number-counter">2</span></button>
      <div id="participants-unified-list">
        <div class="participants-li"><img class="participants-item__avatar" src="https://example.com/a.png"><span class="participants-item__display-name">Ana</span></div>
        <div class="participants-li"><img class="participants-item__avatar" src="https://example.com/a.png"><span class="participants-item__display-name">Adi</span></div>
      </div>`
    const app = boot(overlay + people)
    app.tick(500)
    expect(app.entries()?.[0].speaker).toBe('Speaker 1')
  })

  it('does not click an unverified Participants control', () => {
    const app = boot(overlay + '<button aria-label="Participants"><svg class="SvgParticipants"></svg></button>')
    const click = vi.fn()
    document.querySelector('svg.SvgParticipants')!.closest('button')!.addEventListener('click', click)
    app.tick(3000)
    expect(click).not.toHaveBeenCalled()
  })

  it('recognizes a numeric room id on the Zoom invitation path', () => {
    const app = boot(overlay, 'https://us04web.zoom.us/j/123456789')
    expect(app.sent).toContainEqual({ type: 'resolve-session', roomId: 'zm-123456789' })
  })

  it('replaces revised captions in place, including words inserted at the start', () => {
    const app = boot(overlay)
    const rows = document.querySelectorAll('.live-transcription-subtitle__item')
    app.tick(500)
    rows[0].textContent = 'Kok hilang.Halo, halo. Iya, iya.Apa. Gua mau kan gitu. Kan.'
    rows[1].textContent = 'Kok hilang. Halo, halo. Iya, iya.Apa. Belum mau, kan?'
    app.tick(500)
    expect(app.entries()?.map((e) => e.text)).toEqual([
      'Kok hilang.Halo, halo. Iya, iya.Apa. Gua mau kan gitu. Kan.',
      'Kok hilang. Halo, halo. Iya, iya.Apa. Belum mau, kan?',
    ])
  })

  it('starts a new entry if Zoom reuses a row for another speaker', () => {
    const app = boot(overlay)
    app.tick(500)
    const firstRow = document.querySelector('[id="live-transcription-subtitle"]')!
    firstRow.querySelector('img')!.src = 'https://example.com/b.png'
    firstRow.querySelector('span')!.textContent = 'Pembicara baru.'
    app.tick(500)
    expect(app.entries()?.map(({ speaker, text }) => [speaker, text])).toEqual([
      ['Speaker 1', 'Halo, halo.Halo.'],
      ['B', 'Loh, loh. Halo.'],
      ['Speaker 2', 'Pembicara baru.'],
    ])
  })

  it('flushes captions captured before session resolution without requiring another subtitle update', () => {
    const app = boot(overlay, undefined, true)
    app.tick(500)
    expect(app.entries()).toBeUndefined()
    app.finishSession()
    expect(app.entries()).toHaveLength(2)
  })

  it('does not click the captions control when its off-state is unknown', () => {
    const app = boot('<button aria-label="Tampilkan Teks"><svg class="SvgCaptions"></svg></button>')
    const click = vi.fn()
    document.querySelector('button')!.addEventListener('click', click)
    app.tick(3000)
    expect(click).not.toHaveBeenCalled()
    expect(app.sent.some((m) => m.type === 'meeting-started')).toBe(false)
  })

  it('recognizes the non-host Hide Captions control as captions on', () => {
    const app = boot('<button role="button" aria-label="Hide Captions"><svg class="SvgCaptions"></svg></button>')
    app.tick(3000)
    expect(app.sent.some((m) => m.type === 'meeting-started')).toBe(true)
  })
})
