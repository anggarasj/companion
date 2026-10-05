// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { baseExtensions } from './extensions'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

import { assetPath, attachFiles, externalHref, insertMedia, isVaultPath, mediaKind, pastedFiles, saveFile } from './media'

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
  invokeMock.mockReset()
})

const makeEditor = (markdown: string) =>
  (editor = new Editor({ extensions: baseExtensions(), content: markdown, contentType: 'markdown' }))

describe('media helpers', () => {
  it('tells pictures, players and other files apart by extension', () => {
    expect(mediaKind('.assets/shot-1.PNG')).toBe('image')
    expect(mediaKind('.assets/demo-1.mov')).toBe('video')
    expect(mediaKind('.assets/memo-1.m4a')).toBe('audio')
    expect(mediaKind('.assets/brief-1.pdf')).toBe('file')
    expect(mediaKind('https://x.test/a.webp?v=2')).toBe('image')
  })

  it('knows a vault path from a URL', () => {
    expect(isVaultPath('.assets/a.png')).toBe(true)
    expect(isVaultPath('assets/logo.png')).toBe(true)
    expect(isVaultPath('https://x.test/a.png')).toBe(false)
    expect(isVaultPath('data:image/png;base64,AA')).toBe(false)
    expect(isVaultPath('blob:tauri://localhost/1')).toBe(false)
  })

  it('finds the web link a click landed on, and nothing else', () => {
    const box = document.createElement('div')
    box.innerHTML = '<p><a href="https://x.test/a"><strong>bold link</strong></a> <a href="file:///etc/passwd">f</a> <a href=".assets/a.pdf">a</a> plain</p>'
    const [web, file, local] = Array.from(box.querySelectorAll('a'))
    expect(externalHref(web.querySelector('strong'))).toBe('https://x.test/a')
    expect(externalHref(file)).toBeNull()
    expect(externalHref(local)).toBeNull()
    expect(externalHref(box.querySelector('p'))).toBeNull()
    expect(externalHref(null)).toBeNull()
  })

  it('names an asset with an ASCII slug, keeping or inferring its type', () => {
    expect(assetPath('Screen Shot 2026-10-05 at 08.00.png', 'image/png', 'k1')).toBe(
      '.assets/screen-shot-2026-10-05-at-08-00-k1.png',
    )
    expect(assetPath('Résumé final.PDF', '', 'k2')).toBe('.assets/resume-final-k2.pdf')
    // A clipboard picture without a name still gets the right extension.
    expect(assetPath('', 'image/png', 'k3')).toBe('.assets/file-k3.png')
    expect(assetPath('rapat', 'video/quicktime', 'k4')).toBe('.assets/rapat-k4.mov')
    expect(assetPath('blob', 'application/x-unknown', 'k5')).toBe('.assets/blob-k5.bin')
  })
})

describe('saving and inserting media', () => {
  it('sends the bytes as the raw IPC body with the vault path in a header', async () => {
    invokeMock.mockResolvedValue(null)
    const file = new File([new Uint8Array([1, 2, 3])], 'Clip.mp4', { type: 'video/mp4' })
    const saved = await saveFile(file)
    expect(saved.alt).toBe('Clip')
    expect(saved.src).toMatch(/^\.assets\/clip-[a-z0-9]+\.mp4$/)
    const [cmd, body, options] = invokeMock.mock.calls[0]
    expect(cmd).toBe('write_vault_bytes')
    expect(body).toBeInstanceOf(Uint8Array)
    expect(Array.from(body as Uint8Array)).toEqual([1, 2, 3])
    expect(options).toEqual({ headers: { 'x-vault-rel': saved.src } })
  })

  it('inserts media as image nodes that serialize to markdown image syntax', () => {
    const e = makeEditor('Intro paragraph')
    e.commands.setTextSelection(e.state.doc.content.size - 1)
    insertMedia(e.view, [
      { src: '.assets/shot-k1.png', alt: 'shot' },
      { src: '.assets/demo-k2.mp4', alt: 'demo' },
    ])
    const md = e.getMarkdown()
    expect(md).toContain('![shot](.assets/shot-k1.png)')
    expect(md).toContain('![demo](.assets/demo-k2.mp4)')
    expect(md.indexOf('shot-k1')).toBeLessThan(md.indexOf('demo-k2'))
    expect(md).toContain('Intro paragraph')
  })

  it('attaches a screenshot or a copied image, but keeps rich text as text', () => {
    // jsdom has no DataTransfer; this is the part of it pastedFiles reads.
    const clip = (html: string | null) =>
      ({
        files: [new File(['x'], 'image.png', { type: 'image/png' })],
        getData: (type: string) => (type === 'text/html' && html !== null ? html : ''),
      }) as unknown as DataTransfer
    // Screenshot: only the picture.
    expect(pastedFiles(clip(null))).toHaveLength(1)
    // An image copied from a web page: its HTML is just the <img>.
    expect(pastedFiles(clip('<meta charset="utf-8"><img src="https://x.test/a.png">'))).toHaveLength(1)
    // A table copied from Excel brings a picture of itself; the table wins.
    expect(pastedFiles(clip('<table><tr><td>1</td></tr></table>'))).toHaveLength(0)
    expect(pastedFiles(null)).toHaveLength(0)
  })

  it('leaves a paste without files to ProseMirror', () => {
    const e = makeEditor('x')
    expect(attachFiles(e.view, null, vi.fn())).toBe(false)
    expect(attachFiles(e.view, [] as unknown as FileList, vi.fn())).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('reports a failed save instead of inserting', async () => {
    invokeMock.mockRejectedValue('larger than 200 MB')
    const e = makeEditor('x')
    const onError = vi.fn()
    const file = new File(['x'], 'big.mov', { type: 'video/quicktime' })
    expect(attachFiles(e.view, [file] as unknown as FileList, onError)).toBe(true)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('larger than 200 MB'))
    expect(e.getMarkdown()).not.toContain('big')
  })
})
