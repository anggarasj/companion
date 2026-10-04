// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompletionRequest } from '@meetcc/ai'

const sent: CompletionRequest[] = []
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) =>
    cmd === 'load_ai_settings' ? JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini' }) : cmd === 'load_secret' ? 'sk' : '',
}))
vi.mock('@meetcc/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@meetcc/ai')>()
  return {
    ...real,
    createClient: (s: { provider: string; model: string }) => ({
      provider: s.provider,
      complete: async (req: CompletionRequest) => {
        sent.push({ ...req, user: s.model })
        return 'ok'
      },
    }),
  }
})
const { configuredClient, editorAiSettings, loadSessionAI, saveSessionAI } = await import('./aiSettings')

beforeEach(() => {
  sent.length = 0
  localStorage.clear()
})

describe('AI panel model and effort', () => {
  it('defaults to the saved model and the provider default effort', async () => {
    expect(loadSessionAI()).toEqual({ model: '', effort: 'auto' })
    await (await configuredClient()).complete({ system: 's', user: 'u' })
    expect(sent[0].user).toBe('gpt-4o-mini')
    expect(sent[0].effort).toBeUndefined()
  })

  it('the panel model overrides Settings for editor AI only', async () => {
    saveSessionAI({ model: 'gpt-5-mini', effort: 'high' })
    expect((await editorAiSettings()).model).toBe('gpt-5-mini')
    await (await configuredClient()).complete({ system: 's', user: 'u' })
    expect(sent[0].user).toBe('gpt-5-mini')
    expect(sent[0].effort).toBe('high')
  })

  it('a corrupt preference falls back instead of failing', () => {
    localStorage.setItem('companion:aiSession', '{"effort":"extreme","model":7}')
    expect(loadSessionAI()).toEqual({ model: '', effort: 'auto' })
  })
})
