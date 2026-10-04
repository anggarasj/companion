// Mermaid for the desktop editor: a ```mermaid code block renders as its
// diagram. Same settings as the extension's renderer (apps/extension/src/lib/
// mermaid.ts) — `securityLevel: 'strict'` sanitizes the SVG, which matters
// because a vault file is data that may have come from anywhere.
//
// mermaid is ~400KB, so it loads on the first diagram, not with the app.
type MermaidApi = {
  initialize: (cfg: Record<string, unknown>) => void
  parse: (def: string) => Promise<unknown>
  render: (id: string, def: string) => Promise<{ svg: string }>
}

let api: Promise<MermaidApi> | null = null
let seq = 0

const isLight = (): boolean => document.body.dataset.theme === 'light'

/** Render `def` to sanitized SVG markup. Throws with mermaid's message on bad syntax. */
export async function renderMermaid(def: string): Promise<string> {
  api ??= import('mermaid').then((m) => m.default as unknown as MermaidApi)
  const mermaid = await api
  // Re-initialised per render so a theme switch applies to the next diagram.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isLight() ? 'neutral' : 'dark',
    fontFamily: "'Avenir Next', Avenir, Helvetica, Arial, sans-serif",
  })
  await mermaid.parse(def)
  const { svg } = await mermaid.render(`companion-mermaid-${seq++}`, def)
  return svg
}
