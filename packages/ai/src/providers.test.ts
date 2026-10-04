import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@meetcc/shared';
import { AIError } from './client';
import { createClient, STREAM_IDLE_TIMEOUT_MS } from './providers';

const REQ = { system: 'sys', user: 'usr', json: true };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function stubFetch(response: unknown, status = 200): Captured {
  const captured: Captured = { url: '', headers: {}, body: null };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.headers = init.headers as Record<string, string>;
      captured.body = JSON.parse(init.body as string);
      return new Response(JSON.stringify(response), { status });
    }),
  );
  return captured;
}

const s = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over });
const OPENAI_OK = { choices: [{ message: { content: 'halo' } }] };

afterEach(() => vi.unstubAllGlobals());

describe('openai-compatible wire format', () => {
  it('openai: bearer auth, /chat/completions, response_format json', async () => {
    const cap = stubFetch(OPENAI_OK);
    const out = await createClient(s({ provider: 'openai', apiKey: 'sk-x' })).complete(REQ);
    expect(out).toBe('halo');
    expect(cap.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(cap.headers.Authorization).toBe('Bearer sk-x');
    expect(cap.body.response_format).toEqual({ type: 'json_object' });
    expect(cap.body.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('ollama: no auth header, no response_format, custom base url', async () => {
    const cap = stubFetch(OPENAI_OK);
    await createClient(s({ provider: 'ollama', model: 'llama3.1' })).complete(REQ);
    expect(cap.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(cap.headers.Authorization).toBeUndefined();
    expect(cap.body.response_format).toBeUndefined();
  });

  it('azure: deployment path + api-key header + api-version', async () => {
    const cap = stubFetch(OPENAI_OK);
    await createClient(
      s({ provider: 'azure', apiKey: 'az', baseUrl: 'https://r.openai.azure.com', model: 'gpt4o' }),
    ).complete(REQ);
    expect(cap.url).toContain('https://r.openai.azure.com/openai/deployments/gpt4o/chat/completions');
    expect(cap.url).toContain('api-version=');
    expect(cap.headers['api-key']).toBe('az');
  });
});

describe('anthropic / gemini wire format', () => {
  it('anthropic: x-api-key, version, browser-access headers, system top-level', async () => {
    const cap = stubFetch({ content: [{ text: 'ok' }] });
    const out = await createClient(s({ provider: 'anthropic', apiKey: 'ak' })).complete(REQ);
    expect(out).toBe('ok');
    expect(cap.url).toBe('https://api.anthropic.com/v1/messages');
    expect(cap.headers['x-api-key']).toBe('ak');
    expect(cap.headers['anthropic-version']).toBeTruthy();
    expect(cap.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(cap.body.system).toBe('sys');
  });

  it('gemini: key header, generateContent path, json mime', async () => {
    const cap = stubFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    await createClient(s({ provider: 'gemini', apiKey: 'gk' })).complete(REQ);
    expect(cap.url).toContain(':generateContent');
    expect(cap.headers['x-goog-api-key']).toBe('gk');
    expect(cap.body.generationConfig.responseMimeType).toBe('application/json');
  });
});

describe('SSE-always proxies (e.g. custom gateway)', () => {
  it('joins delta chunks when server streams despite stream:false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
            'data: {"choices":[{"index":0,"delta":{"content":"Hal"},"finish_reason":null}]}',
            ': keepalive-comment',
            'data: {"choices":[{"index":0,"delta":{"content":"o"},"finish_reason":"stop"}]}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    );
    const out = await createClient(
      s({ provider: 'custom', baseUrl: 'https://gw.example/v1', model: 'ag/x' }),
    ).complete(REQ);
    expect(out).toBe('Halo');
  });

  it('skips reasoning-only deltas from a thinking model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":"Let me think"}}]}',
            'data: {"choices":[{"delta":{"content":null,"reasoning_content":" about it."}}]}',
            'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}',
            'data: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    );
    const out = await createClient(
      s({ provider: 'custom', baseUrl: 'https://gw.example/v1', model: 'mimo' }),
    ).complete(REQ);
    expect(out).toBe('{"ok":true}');
  });

  it('fails a stream that reports an upstream error mid-generation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"Rapat membahas"}}]}',
            'data: {"error":{"message":"upstream overloaded","code":502}}',
            '',
          ].join('\n\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    );
    await expect(
      createClient(s({ provider: 'custom', baseUrl: 'https://gw.example/v1' })).complete(REQ),
    ).rejects.toMatchObject({ message: 'upstream overloaded', retryable: true });
  });

  describe('idle timeout while the body streams', () => {
    const enc = new TextEncoder();
    const sse = (content: string) =>
      enc.encode(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`);

    /** A stream that sends one chunk every `gapMs`, then closes. */
    function steady(parts: string[], gapMs: number): Response {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (i === parts.length) return c.close();
          await new Promise((r) => setTimeout(r, gapMs));
          c.enqueue(sse(parts[i++]));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    afterEach(() => vi.useRealTimers());

    it('gives up on a stream that goes silent mid-generation', async () => {
      vi.useFakeTimers();
      // one chunk, then the connection stays open with nothing on it
      const body = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(sse('Rapat')) });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
      );
      const done = createClient(s({ provider: 'custom', baseUrl: 'https://gw.example/v1' })).complete(REQ);
      const outcome = expect(done).rejects.toMatchObject({ retryable: true, message: expect.stringMatching(/^Timeout/) });
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
      await outcome;
    });

    it('lets a long stream run past two minutes while chunks keep coming', async () => {
      vi.useFakeTimers();
      const gap = STREAM_IDLE_TIMEOUT_MS - 30_000; // under the idle limit each time
      vi.stubGlobal('fetch', vi.fn(async () => steady(['Ra', 'pat', ' se', 'lesai'], gap)));
      const done = createClient(s({ provider: 'custom', baseUrl: 'https://gw.example/v1' })).complete(REQ);
      await vi.advanceTimersByTimeAsync(gap * 5); // 4 min in total, far past the old 120s
      await expect(done).resolves.toBe('Rapat selesai');
    });
  });

  it('asks for a stream, still reads a plain JSON body, and treats empty stream as retryable', async () => {
    // a gateway that ignores `stream` and answers with one JSON body
    const cap = stubFetch(OPENAI_OK);
    const out = await createClient(s({ provider: 'custom', baseUrl: 'https://gw.example/v1' })).complete(REQ);
    expect(cap.body.stream).toBe(true);
    expect(out).toBe('halo');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('data: [DONE]\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    await expect(
      createClient(s({ provider: 'custom', baseUrl: 'https://gw.example/v1' })).complete(REQ),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe('error mapping', () => {
  it('429/5xx retryable, 401 not, network error retryable', async () => {
    const client = () => createClient(s({ provider: 'openai', apiKey: 'k' }));
    stubFetch({}, 429);
    await expect(client().complete(REQ)).rejects.toMatchObject({ retryable: true });
    stubFetch({}, 500);
    await expect(client().complete(REQ)).rejects.toMatchObject({ retryable: true });
    stubFetch({}, 401);
    await expect(client().complete(REQ)).rejects.toMatchObject({ retryable: false });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    await expect(client().complete(REQ)).rejects.toThrow(/Network error/);
  });

  it('empty completion is a retryable AIError', async () => {
    stubFetch({ choices: [] });
    await expect(
      createClient(s({ provider: 'openai', apiKey: 'k' })).complete(REQ),
    ).rejects.toBeInstanceOf(AIError);
  });

  it('builtin without browser support fails with clear non-retryable error', async () => {
    await expect(createClient(s({ provider: 'builtin' })).complete(REQ)).rejects.toMatchObject({
      retryable: false,
    });
  });
});

describe('subscription sign-ins', () => {
  const signedIn = (provider: 'chatgpt' | 'google-codeassist', over = {}) =>
    s({
      provider,
      oauth: { ...DEFAULT_SETTINGS.oauth, provider, accessToken: 'tok', ...over },
    });

  it('chatgpt: /responses with instructions and input items, not messages', async () => {
    const cap = stubFetch({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'halo' }] }],
    });
    const out = await createClient(signedIn('chatgpt', { accountId: 'acc_1' })).complete(REQ);

    expect(out).toBe('halo');
    expect(cap.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(cap.headers.Authorization).toBe('Bearer tok');
    expect(cap.headers['chatgpt-account-id']).toBe('acc_1');
    expect(cap.body.instructions).toBe('sys');
    expect(cap.body.messages).toBeUndefined();
    expect(cap.body.input[0].content[0]).toEqual({ type: 'input_text', text: 'usr' });
  });

  it('chatgpt: reads a stream even though the request asked for one body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: {"type":"response.output_text.delta","delta":"ha"}\n' +
              'data: {"type":"response.completed"}\n' +
              'data: {"type":"response.output_text.delta","delta":"lo"}\n',
            { status: 200 },
          ),
      ),
    );
    expect(await createClient(signedIn('chatgpt')).complete(REQ)).toBe('halo');
  });

  it('code assist: gemini request wrapped in the project envelope', async () => {
    const cap = stubFetch({
      response: { candidates: [{ content: { parts: [{ text: 'halo' }] } }] },
    });
    const out = await createClient(
      signedIn('google-codeassist', { projectId: 'proj-1' }),
    ).complete(REQ);

    expect(out).toBe('halo');
    expect(cap.url).toBe('https://cloudcode-pa.googleapis.com/v1internal:generateContent');
    expect(cap.body.project).toBe('proj-1');
    expect(cap.body.request.systemInstruction.parts[0].text).toBe('sys');
    expect(cap.body.request.generationConfig.responseMimeType).toBe('application/json');
  });

  it('code assist: accepts a body the backend already unwrapped', async () => {
    stubFetch({ candidates: [{ content: { parts: [{ text: 'halo' }] } }] });
    expect(await createClient(signedIn('google-codeassist')).complete(REQ)).toBe('halo');
  });
});

describe('reasoning effort', () => {
  const R = { system: 'sys', user: 'usr', effort: 'high' as const };

  it('is sent only to OpenAI models that take it', async () => {
    let cap = stubFetch(OPENAI_OK);
    await createClient(s({ provider: 'openai', apiKey: 'k', model: 'gpt-5-mini' })).complete(R);
    expect(cap.body.reasoning_effort).toBe('high');
    cap = stubFetch(OPENAI_OK);
    await createClient(s({ provider: 'openai', apiKey: 'k', model: 'gpt-4o-mini' })).complete(R);
    expect(cap.body).not.toHaveProperty('reasoning_effort');
  });

  it('never reaches a local model', async () => {
    const cap = stubFetch(OPENAI_OK);
    await createClient(s({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3.1' })).complete(R);
    expect(cap.body).not.toHaveProperty('reasoning_effort');
    expect(cap.body).not.toHaveProperty('reasoning');
  });

  it('openrouter uses its normalised reasoning field', async () => {
    const cap = stubFetch(OPENAI_OK);
    await createClient(s({ provider: 'openrouter', apiKey: 'k', model: 'anthropic/claude-sonnet-4.5' })).complete(R);
    expect(cap.body.reasoning).toEqual({ effort: 'high' });
  });

  it('gemini 2.5+ gets a thinking budget, 2.0 does not', async () => {
    let cap = stubFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    await createClient(s({ provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash' })).complete(R);
    expect(cap.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 24576 });
    cap = stubFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    await createClient(s({ provider: 'gemini', apiKey: 'k', model: 'gemini-2.0-flash' })).complete(R);
    expect(cap.body.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('anthropic enables thinking and reads the text block, not the thinking block', async () => {
    const cap = stubFetch({
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'answer' },
      ],
    });
    const out = await createClient(s({ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-5' })).complete({ ...R, effort: 'low' });
    expect(out).toBe('answer');
    expect(cap.body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(cap.body.max_tokens).toBe(4096 + 1024);
  });

  it('no effort, no extra fields', async () => {
    const cap = stubFetch({ content: [{ type: 'text', text: 'x' }] });
    await createClient(s({ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-5' })).complete({ system: 's', user: 'u' });
    expect(cap.body).not.toHaveProperty('thinking');
    expect(cap.body.max_tokens).toBe(4096);
  });
});

describe('reasoning effort on OpenAI-compatible gateways', () => {
  const R = { system: 'sys', user: 'usr', effort: 'medium' as const };

  it('a gateway-prefixed reasoning model gets reasoning_effort', async () => {
    const cap = stubFetch(OPENAI_OK);
    await createClient(s({ provider: 'custom', baseUrl: 'https://gw.example/v1', model: 'ag/gemini-3.8-flash' })).complete(R);
    expect(cap.body.reasoning_effort).toBe('medium');
  });

  it('retries once without it when the gateway rejects the field', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        return body.reasoning_effort
          ? new Response('{"error":"Unrecognized request argument: reasoning_effort"}', { status: 400 })
          : new Response(JSON.stringify(OPENAI_OK), { status: 200 });
      }),
    );
    const out = await createClient(s({ provider: 'custom', baseUrl: 'https://gw.example/v1', model: 'gemini-2.5-pro' })).complete(R);
    expect(out).toBe('halo');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
  });

  it('a 400 about something else is not retried', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (calls++, new Response('{"error":"bad model"}', { status: 400 }))));
    await expect(
      createClient(s({ provider: 'custom', baseUrl: 'https://gw.example/v1', model: 'gpt-5' })).complete(R),
    ).rejects.toThrow('HTTP 400');
    expect(calls).toBe(1);
  });
});
