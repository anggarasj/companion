import { jsPDF } from 'jspdf'
import { invoke } from '@tauri-apps/api/core'
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
export async function saveExport(filename: string, blob: Blob): Promise<string | null> {
  // ponytail: bytes travel as a JSON number array — fine for notes; switch to a raw IPC body if exports reach many MB.
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
  return invoke<string | null>('export_file', { name: filename, bytes })
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
): string {
  const title = note.title || 'Untitled'

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
            <span class="property-val">${v}</span>
          </div>`,
          )
          .join('')}
      </div>`
    }
  }

  const titleHtml = options.includeTitle && note.title ? `<h1 class="page-title">${note.title}</h1>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0a0d12;
        --fg: #dbe2ee;
        --muted: #8b95a9;
        --card-bg: #0f131b;
        --border: #1d2434;
        --accent: #46e394;
        --code-bg: #131926;
      }
    }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 15px;
      line-height: 1.7;
      margin: 0;
      padding: 40px 20px;
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

/** Generate a clean formatted PDF document using jsPDF */
export function buildExportPdf(
  note: VaultNote,
  options: Pick<ExportOptions, 'includeMetadata' | 'includeTitle'>,
): Blob {
  const doc = new jsPDF({
    unit: 'mm',
    format: 'a4',
  })

  const M = 20
  const pageWidth = 210
  const maxW = pageWidth - M * 2
  const pageHeight = 297
  let y = M

  const ensureSpace = (needMm: number) => {
    if (y + needMm > pageHeight - M) {
      doc.addPage()
      y = M
    }
  }

  // Title
  if (options.includeTitle && note.title) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(22)
    doc.setTextColor(28, 36, 51)
    const titleLines = doc.splitTextToSize(note.title, maxW)
    ensureSpace(titleLines.length * 9 + 4)
    doc.text(titleLines, M, y)
    y += titleLines.length * 9 + 4
  }

  // Metadata / Properties
  if (options.includeMetadata) {
    const props: Array<[string, string]> = []
    if (note.status) props.push(['Status', note.status])
    if (note.priority) props.push(['Priority', note.priority])
    if (note.assignee) props.push(['Assignee', note.assignee])
    if (note.dueDate) props.push(['Due Date', note.dueDate])
    if (note.updatedAt) props.push(['Updated', note.updatedAt])

    if (props.length > 0) {
      ensureSpace(12 + props.length * 5)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(100, 110, 125)
      props.forEach(([k, v]) => {
        doc.text(`${k}: ${v}`, M, y)
        y += 5
      })
      y += 3
      doc.setDrawColor(220, 226, 235)
      doc.setLineWidth(0.3)
      doc.line(M, y, M + maxW, y)
      y += 6
    }
  }

  // Parse markdown lines
  const lines = note.body.split('\n')
  let inCode = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()

    if (trimmed.startsWith('```')) {
      inCode = !inCode
      continue
    }

    if (!trimmed) {
      y += 3
      continue
    }

    if (inCode) {
      doc.setFont('courier', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(60, 70, 85)
      const codeLines = doc.splitTextToSize(raw, maxW - 4)
      ensureSpace(codeLines.length * 4.5 + 2)
      doc.setFillColor(245, 247, 250)
      doc.rect(M, y - 3, maxW, codeLines.length * 4.5 + 2, 'F')
      doc.text(codeLines, M + 2, y + 1)
      y += codeLines.length * 4.5 + 4
      continue
    }

    // Heading 1
    if (trimmed.startsWith('# ')) {
      ensureSpace(14)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(16)
      doc.setTextColor(20, 28, 40)
      const text = trimmed.replace(/^#\s+/, '')
      const wrapped = doc.splitTextToSize(text, maxW)
      doc.text(wrapped, M, y)
      y += wrapped.length * 7 + 3
      continue
    }

    // Heading 2
    if (trimmed.startsWith('## ')) {
      ensureSpace(12)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(13)
      doc.setTextColor(30, 40, 55)
      const text = trimmed.replace(/^##\s+/, '')
      const wrapped = doc.splitTextToSize(text, maxW)
      doc.text(wrapped, M, y)
      y += wrapped.length * 6 + 2
      continue
    }

    // Heading 3
    if (trimmed.startsWith('### ')) {
      ensureSpace(10)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(11)
      doc.setTextColor(45, 55, 72)
      const text = trimmed.replace(/^###\s+/, '')
      const wrapped = doc.splitTextToSize(text, maxW)
      doc.text(wrapped, M, y)
      y += wrapped.length * 5 + 2
      continue
    }

    // List item
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const isNum = /^\d+\.\s+/.test(trimmed)
      const bullet = isNum ? trimmed.match(/^(\d+\.)/)?.[1] + ' ' : '• '
      const text = trimmed.replace(/^([-*]|\d+\.)\s+/, '')
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.setTextColor(35, 45, 60)
      const wrapped = doc.splitTextToSize(text, maxW - 6)
      ensureSpace(wrapped.length * 5 + 1)
      doc.text(bullet, M, y)
      doc.text(wrapped, M + 5, y)
      y += wrapped.length * 5 + 1.5
      continue
    }

    // Table row
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (/^\|[\s:|-]+\|$/.test(trimmed)) continue
      const cells = trimmed
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())

      const colW = maxW / Math.max(1, cells.length)
      ensureSpace(7)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(30, 40, 55)
      cells.forEach((cell, cIdx) => {
        const truncated = doc.splitTextToSize(cell, colW - 2)[0] || ''
        doc.text(truncated, M + cIdx * colW + 1, y)
      })
      y += 5.5
      doc.setDrawColor(230, 235, 242)
      doc.line(M, y - 1, M + maxW, y - 1)
      continue
    }

    // Regular paragraph
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(35, 45, 60)
    const wrapped = doc.splitTextToSize(trimmed, maxW)
    ensureSpace(wrapped.length * 5 + 2)
    doc.text(wrapped, M, y)
    y += wrapped.length * 5 + 2
  }

  return doc.output('blob')
}

/** Build the export and save it; the saved path, or null when cancelled. */
export async function exportNote(
  note: VaultNote,
  bodyHtml: string,
  options: ExportOptions,
): Promise<string | null> {
  const ext = options.format === 'markdown' ? 'md' : options.format
  const filename = sanitizeFilename(note.title || 'untitled', ext)

  const blob =
    options.format === 'markdown'
      ? new Blob([buildExportMarkdown(note, options)], { type: 'text/markdown;charset=utf-8' })
      : options.format === 'html'
        ? new Blob([buildExportHtml(note, bodyHtml, options)], { type: 'text/html;charset=utf-8' })
        : buildExportPdf(note, options)
  return saveExport(filename, blob)
}
