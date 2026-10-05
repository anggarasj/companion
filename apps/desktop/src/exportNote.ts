import { jsPDF } from 'jspdf'
import { invoke } from '@tauri-apps/api/core'
import { renderMermaid } from './editor/mermaid'
import type { VaultNote } from '@meetcc/vault'

export type ExportFormat = 'markdown' | 'html' | 'pdf'

export interface ExportOptions {
  format: ExportFormat
  includeMetadata: boolean
  includeTitle: boolean
}

/** Sanitize note title for safe file naming */
export function sanitizeFilename(title: string, ext: string): string {
  const clean = (title || 'untitled')
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 100)
  return `${clean || 'untitled'}.${ext}`
}

/**
 * Save through the native save dialog. `<a download>` does nothing in the
 * Tauri WebView, so the bytes go to Rust, which asks where and writes them.
 * Resolves to the saved path, or null when the dialog was cancelled.
 */
export async function saveExport(filename: string, dir: string, blob: Blob): Promise<string | null> {
  // ponytail: bytes travel as a JSON number array — fine for notes; switch to a raw IPC body if exports reach many MB.
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
  return invoke<string | null>('export_file', { name: filename, dir, bytes })
}

/** Text for HTML: titles and properties are user data, not markup. */
const esc = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Swap every \`\`\`mermaid block in the editor's HTML for its rendered diagram.
 * A block that does not parse stays as code, so the export still carries it.
 */
export async function withDiagrams(
  bodyHtml: string,
  render: (def: string) => Promise<string>,
): Promise<string> {
  const doc = new DOMParser().parseFromString(`<body>${bodyHtml}</body>`, 'text/html')
  for (const code of doc.querySelectorAll('pre > code.language-mermaid')) {
    try {
      const figure = doc.createElement('figure')
      figure.className = 'mermaid'
      // Mermaid's own output under securityLevel 'strict', sanitized by its DOMPurify;
      // parsed into an inert DOMParser document, and the PDF frame runs no scripts.
      figure.innerHTML = await render(code.textContent ?? '')
      code.parentElement?.replaceWith(figure)
    } catch {
      /* bad syntax: the source stays in the export, readable as code */
    }
  }
  return doc.body.innerHTML
}

/**
 * Where each PDF page ends, in CSS px of the laid-out document. A page ends at
 * the last block that fits on it (`bottoms`: where paragraphs, rows, list
 * items and diagrams end), so no line or table row is sliced in half; only a
 * single block taller than a page is cut, at the page edge.
 */
export function pageBreaks(bottoms: number[], total: number, pageH: number): number[] {
  const cuts = [...new Set(bottoms.map(Math.ceil))].filter((b) => b > 0 && b < total).sort((a, b) => a - b)
  const ends: number[] = []
  let start = 0
  let i = 0
  while (total - start > pageH) {
    let end = start + pageH
    while (i < cuts.length && cuts[i] <= start) i++
    let j = i
    while (j < cuts.length && cuts[j] <= start + pageH) j++
    if (j > i) end = cuts[j - 1]
    ends.push(end)
    start = end
  }
  ends.push(total)
  return ends
}

/** Generate markdown text with optional YAML frontmatter and title */
export function buildExportMarkdown(
  note: VaultNote,
  options: Pick<ExportOptions, 'includeMetadata' | 'includeTitle'>,
): string {
  let output = ''

  if (options.includeMetadata) {
    const metaLines: string[] = ['---']
    if (note.title) metaLines.push(`title: ${JSON.stringify(note.title)}`)
    if (note.status) metaLines.push(`status: ${note.status}`)
    if (note.priority) metaLines.push(`priority: ${note.priority}`)
    if (note.assignee) metaLines.push(`assignee: ${JSON.stringify(note.assignee)}`)
    if (note.dueDate) metaLines.push(`dueDate: ${note.dueDate}`)
    if (note.startedAt) metaLines.push(`startedAt: ${note.startedAt}`)
    if (note.updatedAt) metaLines.push(`updatedAt: ${note.updatedAt}`)
    if (note.platform && note.platform !== 'manual') metaLines.push(`platform: ${note.platform}`)
    if (note.source) metaLines.push(`source: ${JSON.stringify(note.source)}`)
    metaLines.push('---', '')
    output += metaLines.join('\n')
  }

  if (options.includeTitle && note.title) {
    const trimmed = note.body.trimStart()
    if (!trimmed.startsWith('# ')) {
      output += `# ${note.title}\n\n`
    }
  }

  output += note.body
  return output
}

/** Generate a standalone HTML document styled like Notion */
export function buildExportHtml(
  note: VaultNote,
  bodyHtml: string,
  options: Pick<ExportOptions, 'includeMetadata' | 'includeTitle'>,
  forPdf = false,
): string {
  const title = esc(note.title || 'Untitled')

  let propertiesHtml = ''
  if (options.includeMetadata) {
    const rows: Array<[string, string]> = []
    if (note.status) rows.push(['Status', note.status])
    if (note.priority) rows.push(['Priority', note.priority])
    if (note.assignee) rows.push(['Assignee', note.assignee])
    if (note.dueDate) rows.push(['Due Date', note.dueDate])
    if (note.updatedAt) rows.push(['Updated', note.updatedAt])
    if (note.source) rows.push(['Source', note.source])
    if (note.platform && note.platform !== 'manual') rows.push(['Platform', note.platform])

    if (rows.length > 0) {
      propertiesHtml = `
      <div class="properties">
        ${rows
          .map(
            ([k, v]) => `
          <div class="property-row">
            <span class="property-key">${k}</span>
            <span class="property-val">${esc(v)}</span>
          </div>`,
          )
          .join('')}
      </div>`
    }
  }

  const titleHtml = options.includeTitle && note.title ? `<h1 class="page-title">${title}</h1>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${forPdf ? '<meta name="color-scheme" content="light">' : ''}
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #ffffff;
      --fg: #1c2433;
      --muted: #55617a;
      --card-bg: #f8fafc;
      --border: #e2e8f0;
      --accent: #0c8f60;
      --code-bg: #f1f4f9;
    }
    ${forPdf ? '' : `@media (prefers-color-scheme: dark) {
      :root {
        --bg: #0a0d12;
        --fg: #dbe2ee;
        --muted: #8b95a9;
        --card-bg: #0f131b;
        --border: #1d2434;
        --accent: #46e394;
        --code-bg: #131926;
      }
    }`}
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 15px;
      line-height: 1.7;
      margin: 0;
      padding: ${forPdf ? '0' : '40px 20px'};
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    .page-title {
      font-size: 2.2em;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.25;
      margin: 0 0 16px 0;
    }
    .properties {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 10px 16px;
      padding: 14px 16px;
      margin-bottom: 28px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .property-row {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .property-key {
      color: var(--muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 10px;
    }
    .property-val {
      font-size: 13px;
    }
    h1, h2, h3, h4 {
      font-weight: 600;
      line-height: 1.3;
      margin-top: 1.5em;
      margin-bottom: 0.4em;
    }
    h1 { font-size: 1.8em; }
    h2 { font-size: 1.4em; }
    h3 { font-size: 1.2em; }
    p { margin: 0 0 1em 0; }
    ul, ol { padding-left: 1.5em; margin: 0 0 1em 0; }
    li + li { margin-top: 0.25em; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5em 0;
      font-size: 14px;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 12px;
      text-align: left;
    }
    th {
      background: var(--code-bg);
      font-weight: 600;
    }
    code {
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.9em;
    }
    pre {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
    }
    pre code {
      background: transparent;
      padding: 0;
    }
    blockquote {
      margin: 1em 0;
      padding-left: 14px;
      border-left: 3px solid var(--accent);
      color: var(--muted);
    }
    hr {
      border: 0;
      border-top: 1px solid var(--border);
      margin: 2em 0;
    }
    a {
      color: var(--accent);
      text-decoration: underline;
    }
    figure.mermaid {
      margin: 1.5em 0;
      text-align: center;
    }
    figure.mermaid svg {
      max-width: 100%;
      height: auto;
    }
    tr { break-inside: avoid; }
    /* Tiptap wraps every cell in a <p>; its paragraph margin would double each row. */
    th p, td p { margin: 0; }
  </style>
</head>
<body>
  <div class="container">
    ${titleHtml}
    ${propertiesHtml}
    <div class="content">
      ${bodyHtml}
    </div>
  </div>
</body>
</html>`
}

const A4_W_MM = 210
const A4_H_MM = 297
const MARGIN_MM = 16
/** The width, in CSS px, the page is laid out at before it is scaled onto A4. */
const PAGE_PX = 720
/** Tallest stretch, in CSS px, drawn onto one canvas: 720×2 by 5000×2 is ~14.4M px. */
const CHUNK_PX = 5000
/** Blocks a page may end after; see `pageBreaks`. */
const BLOCKS = '.container > *, .content > *, .content li, .content tr, .property-row'

/**
 * A PDF of the export HTML, so tables, formatting and diagrams look the way
 * they do in the HTML export. The page is laid out in a hidden iframe and
 * painted with html2canvas, then cut into A4 pages between blocks.
 * ponytail: pages are images, so PDF text is not selectable; a vector renderer is the upgrade if that matters.
 */
export async function buildExportPdf(
  note: VaultNote,
  bodyHtml: string,
  options: Pick<ExportOptions, 'includeMetadata' | 'includeTitle'>,
): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([buildExportHtml(note, bodyHtml, options, true)], { type: 'text/html' }))
  const frame = document.createElement('iframe')
  // Same origin so the document can be read; no scripts, so nothing in a note can run.
  frame.setAttribute('sandbox', 'allow-same-origin')
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${PAGE_PX}px;height:1000px;border:0`
  try {
    await new Promise<void>((resolve) => {
      frame.onload = () => resolve()
      frame.src = url
      document.body.appendChild(frame)
    })
    const doc = frame.contentDocument
    if (!doc) throw new Error('export frame did not load')
    await doc.fonts.ready
    const body = doc.body
    frame.style.height = `${body.scrollHeight}px`
    const { default: html2canvas } = await import('html2canvas')

    const mmPerPx = (A4_W_MM - 2 * MARGIN_MM) / PAGE_PX
    const top = body.getBoundingClientRect().top
    const bottoms = [...body.querySelectorAll(BLOCKS)].map((el) => el.getBoundingClientRect().bottom - top)
    const ends = pageBreaks(bottoms, body.scrollHeight, (A4_H_MM - 2 * MARGIN_MM) / mmPerPx)

    // Drawn a few pages at a time, never the whole document at once: past a
    // browser's canvas size limit a canvas silently draws nothing, which turned
    // a long note into a PDF of blank pages. A chunk stays under 16.7M device
    // pixels, WebKit's tightest limit; html2canvas re-clones the document per
    // call, so chunks rather than single pages keep a long export bearable.
    // ponytail: ~2 min for a 116-page note in Chrome; render off the main thread if that ever matters.
    const scale = 2
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
    let from = 0
    let page = 0
    while (page < ends.length) {
      let last = page
      while (last + 1 < ends.length && ends[last + 1] - from <= CHUNK_PX) last++
      const chunk = await html2canvas(body, {
        scale,
        backgroundColor: '#ffffff',
        logging: false,
        windowWidth: PAGE_PX,
        y: top + from,
        height: ends[last] - from,
      })
      const chunkFrom = from
      for (; page <= last; page++) {
        if (page) pdf.addPage()
        const end = ends[page]
        const slice = document.createElement('canvas')
        slice.width = chunk.width
        slice.height = Math.ceil((end - from) * scale)
        slice.getContext('2d')?.drawImage(chunk, 0, -Math.floor((from - chunkFrom) * scale))
        pdf.addImage(slice, 'PNG', MARGIN_MM, MARGIN_MM, A4_W_MM - 2 * MARGIN_MM, (end - from) * mmPerPx)
        from = end
      }
    }
    return pdf.output('blob')
  } finally {
    frame.remove()
    URL.revokeObjectURL(url)
  }
}

/** Build the export and save it; the saved path, or null when cancelled. */
export async function exportNote(
  note: VaultNote,
  bodyHtml: string,
  options: ExportOptions,
  dir = '',
): Promise<string | null> {
  const ext = options.format === 'markdown' ? 'md' : options.format
  const filename = sanitizeFilename(note.title || 'untitled', ext)

  if (options.format === 'markdown') {
    const md = buildExportMarkdown(note, options)
    return saveExport(filename, dir, new Blob([md], { type: 'text/markdown;charset=utf-8' }))
  }
  const html = await withDiagrams(bodyHtml, (def) => renderMermaid(def, { forExport: true }))
  const blob =
    options.format === 'html'
      ? new Blob([buildExportHtml(note, html, options)], { type: 'text/html;charset=utf-8' })
      : await buildExportPdf(note, html, options)
  return saveExport(filename, dir, blob)
}
