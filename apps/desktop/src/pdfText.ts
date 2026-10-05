// The text of a vault PDF, for the AI to read. pdf.js is loaded only when a
// PDF is actually read, and its legacy build is used because the desktop runs
// on whatever WebView the OS ships (an older WKWebView included).
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

/** Pages read at most; a scanned 900-page manual is not context. */
const MAX_PAGES = 200

export async function pdfText(bytes: ArrayBuffer | Uint8Array, maxPages = MAX_PAGES): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // In the WebView the worker is a bundled file ('self' under the CSP); under
  // Node (tests) pdf.js runs it in-process on its own.
  if (typeof document !== 'undefined' && !pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  // A plain Uint8Array: pdf.js refuses Node's Buffer subclass, and a copy is cheap next to parsing.
  const data = new Uint8Array(bytes)
  const task = pdfjs.getDocument({ data, verbosity: 0 })
  const pdf = await task.promise
  try {
    const pages: string[] = []
    const last = Math.min(pdf.numPages, maxPages)
    for (let i = 1; i <= last; i++) {
      const content = await (await pdf.getPage(i)).getTextContent()
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .trim()
      pages.push(`[page ${i}]\n${text}`)
    }
    if (pdf.numPages > last) pages.push(`[${pdf.numPages - last} more pages not read]`)
    return pages.join('\n\n')
  } finally {
    await task.destroy()
  }
}
