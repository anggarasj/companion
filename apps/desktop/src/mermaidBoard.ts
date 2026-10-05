// Mermaid to Excalidraw elements, the way Excalidraw's own "Mermaid to
// Excalidraw" dialog does it: flowcharts, sequence and class diagrams become
// real shapes, other diagram types an image. Mermaid renders through the DOM,
// so this only runs in the WebView; both libraries load on first use, keeping
// Excalidraw out of the main bundle.
export interface MermaidBoard {
  elements: unknown[]
  files: Record<string, unknown>
}

export async function mermaidToBoard(definition: string): Promise<MermaidBoard> {
  const [{ parseMermaidToExcalidraw }, { convertToExcalidrawElements }] = await Promise.all([
    import('@excalidraw/mermaid-to-excalidraw'),
    import('@excalidraw/excalidraw'),
  ])
  let parsed
  try {
    parsed = await parseMermaidToExcalidraw(definition)
  } catch {
    // The dialog's own retry: double quotes trip the parser in labels.
    parsed = await parseMermaidToExcalidraw(definition.replace(/"/g, "'"))
  }
  return {
    elements: convertToExcalidrawElements(parsed.elements, { regenerateIds: true }) as unknown[],
    files: (parsed.files ?? {}) as Record<string, unknown>,
  }
}
