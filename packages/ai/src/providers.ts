import type { Settings } from '@meetcc/shared';
import { AIError, resolveConfig, type AIClient, type CompletionRequest, type Effort } from './client';
import { t } from '@meetcc/shared/i18n';

// A hung provider (no response, no error) would leave the pipeline stuck on
// "AI Processing" forever. Abort after this long so it fails as retryable.
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * The `fetch` every provider call goes through.
 *
 * A seam, not indirection for its own sake: the desktop app runs in a WebView
 * whose CSP allows `connect-src 'self' ipc:` and nothing else, so a request to
 * a provider is refused before it leaves. Widening the CSP is not available —
 * base URLs are typed by the user, so there is no host list to enumerate — and
 * the way out is Rust, whose `fetch` is not subject to the page's CSP.
 *
 * The extension leaves this alone and keeps the global.
 */
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let doFetch: Fetch = (url, init) => fetch(url, init);

/** Route provider requests through `impl`. Called once, at startup. */
export function setFetch(impl: Fetch): void {
  doFetch = impl;
}

export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await doFetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new AIError(`Timeout: provider tidak merespons dalam ${REQUEST_TIMEOUT_MS / 1000}s`, true);
    }
    const msg = (e as Error).message;
    if (/Failed to fetch|NetworkError/i.test(msg) && /localhost|127\.0\.0\.1/i.test(url)) {
      throw new AIError(
        `Koneksi ke local LLM gagal (${msg}). Pastikan service aktif dan CORS diizinkan (mis. OLLAMA_ORIGINS="*").`,
        true,
      );
    }
    throw new AIError(`Network error: ${(e as Error).message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    // 429/5xx are transient; 4xx config errors are not
    throw new AIError(`HTTP ${res.status}: ${text}`, res.status === 429 || res.status >= 500);
  }
  return res.json();
}

/**
 * Join a chat/completions SSE stream back into one string — the normal shape
 * now that OpenAI-compatible requests ask for `stream: true`, and also what
 * some proxies send when asked not to stream.
 *
 * An `error` chunk fails the call: gateways such as OpenRouter report an
 * upstream failure mid-generation as `data: {"error":…}` under a 200, and the
 * content gathered before it is a truncated answer, not a result.
 */
export function parseSSEContent(text: string): string {
  let out = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue; // keepalive / comment line
    }
    if (chunk?.error) {
      const err = chunk.error;
      throw new AIError(typeof err === 'string' ? err : (err.message ?? 'Stream error'), true);
    }
    out += chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content ?? '';
  }
  return out;
}

/** How long a response body may go without a single byte before the call
 *  counts as stalled. Idle rather than total: a long summary legitimately
 *  streams for minutes, a hung one stops sending. */
export const STREAM_IDLE_TIMEOUT_MS = 90_000;

/**
 * Read a response body, failing after `STREAM_IDLE_TIMEOUT_MS` of silence.
 *
 * `fetchWithTimeout` only bounds the wait for headers. A non-streamed answer
 * arrived with its headers, so that covered the whole generation; a streamed
 * one sends headers at once and does all its work in the body, which
 * `res.text()` would wait on forever if the server stalled mid-stream.
 */
async function readBody(res: Response): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      void reader.cancel().catch(() => undefined); // resolves the pending read
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (stalled) {
        throw new AIError(
          `Timeout: provider berhenti mengirim data selama ${STREAM_IDLE_TIMEOUT_MS / 1000}s`,
          true,
        );
      }
      if (done) break;
      text += decoder.decode(value, { stream: true });
      arm();
    }
    return text + decoder.decode();
  } catch (e) {
    if (e instanceof AIError) throw e;
    // the connection dropped while the body was still arriving
    throw new AIError(`Network error: ${(e as Error).message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the configured model takes a reasoning-effort setting, and in which
 * wire shape. Model-gated on purpose: OpenAI answers `reasoning_effort` sent
 * to gpt-4o with a 400, so a setting for models that cannot use it would turn
 * a working provider into a broken one. Unknown names get nothing.
 */
export function effortKind(
  s: Pick<Settings, 'provider' | 'model'>,
): 'openai' | 'openrouter' | 'responses' | 'gemini' | 'anthropic' | null {
  const model = s.model.toLowerCase();
  switch (s.provider) {
    case 'chatgpt':
      return 'responses';
    case 'openai':
    case 'azure':
    case 'custom':
    case 'ollama':
    case 'lmstudio':
      // OpenAI-compatible endpoints, gateways included: `reasoning_effort` is
      // the field Gemini's and most gateways' compatible APIs accept too.
      return REASONING_MODEL.test(model) ? 'openai' : null;
    case 'openrouter':
      // OpenRouter normalises `reasoning` across vendors and drops it for
      // models without it.
      return 'openrouter';
    case 'gemini':
    case 'google-codeassist':
      return /gemini-(2\.5|[3-9])/.test(model) ? 'gemini' : null;
    case 'anthropic':
      // Extended thinking: Claude 3.7 and every family from 4 on.
      return /claude-(3-7|(opus|sonnet|haiku)-[4-9]|[4-9])/.test(model) ? 'anthropic' : null;
    default:
      return null;
  }
}

/**
 * Model families that reason, by name, whatever prefix a gateway puts in front
 * ("ag/gemini-3.8-flash", "openai/gpt-5"). Kept to families documented to
 * take an effort setting; a name not on it gets no field rather than a 400.
 */
const REASONING_MODEL =
  /(^|[/:])(o\d|gpt-5|gpt-oss|gemini-(2\.5|[3-9])|claude-(3-7|(opus|sonnet|haiku)-[4-9]|[4-9])|deepseek-(r1|reasoner)|qwen3|qwq|magistral|grok-([4-9]|3-mini))/;

export const supportsEffort = (s: Pick<Settings, 'provider' | 'model'>): boolean => effortKind(s) !== null;

/** Token budgets for the providers that think in tokens rather than levels. */
const THINKING_BUDGET: Record<Effort, number> = { low: 1024, medium: 8192, high: 24576 };

/** The request fields that carry `effort` for this model, or nothing. */
function effortFields(cfg: Settings, effort: Effort | undefined): Record<string, unknown> {
  if (!effort) return {};
  switch (effortKind(cfg)) {
    case 'openai':
      return { reasoning_effort: effort };
    case 'openrouter':
    case 'responses':
      return { reasoning: { effort } };
    default:
      return {};
  }
}

/** chat/completions call tolerant to both JSON and SSE-stream responses. */
async function chatCompletions(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<string> {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await readBody(res);
  if (!res.ok) {
    throw new AIError(
      `HTTP ${res.status}: ${text.slice(0, 300)}`,
      res.status === 429 || res.status >= 500,
    );
  }
  const isSSE =
    res.headers.get('content-type')?.includes('event-stream') ||
    text.trimStart().startsWith('data:');
  if (isSSE) {
    const joined = parseSSEContent(text);
    if (!joined) throw new AIError('Empty completion', true);
    return joined;
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AIError(`Respons bukan JSON: ${text.slice(0, 120)}`, true);
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content) throw new AIError('Empty completion', true);
  return content;
}

/**
 * OpenAI / Ollama / LM Studio / OpenRouter / Custom — one wire format.
 *
 * Streamed on purpose. A non-streamed completion sends nothing back until the
 * whole answer exists, and a meeting summary (or a reasoning model thinking
 * before it) can take well over a minute. Gateways and reverse proxies cut a
 * silent connection at around 60s, which the browser reports only as "Failed
 * to fetch" while the server carries on. With a stream, tokens keep the
 * connection busy. `chatCompletions` already reads either shape, so a gateway
 * that ignores `stream` and answers with one JSON body still works.
 */
function openAICompatible(cfg: Settings): AIClient {
  const send = (req: CompletionRequest) =>
    chatCompletions(
      `${cfg.baseUrl}/chat/completions`,
      cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      {
        model: cfg.model,
        temperature: 0.2,
        stream: true,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        ...(req.json && (cfg.provider === 'openai' || cfg.provider === 'openrouter')
          ? { response_format: { type: 'json_object' } }
          : {}),
        ...effortFields(cfg, req.effort),
      },
    );
  return {
    provider: cfg.provider,
    async complete(req: CompletionRequest) {
      try {
        return await send(req);
      } catch (e) {
        // A gateway that forwards to a model without the setting answers 400
        // naming it. The user asked for an answer, not for that field: retry
        // once without it.
        if (req.effort && e instanceof AIError && /HTTP 400/.test(e.message) && /reason/i.test(e.message)) {
          return send({ ...req, effort: undefined });
        }
        throw e;
      }
    },
  };
}

function azure(cfg: Settings): AIClient {
  return {
    provider: 'azure',
    complete: (req: CompletionRequest) =>
      chatCompletions(
        `${cfg.baseUrl}/openai/deployments/${encodeURIComponent(cfg.model)}` +
          `/chat/completions?api-version=2024-06-01`,
        { 'api-key': cfg.apiKey },
        {
          temperature: 0.2,
          stream: false,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          ...effortFields(cfg, req.effort),
        },
      ),
  };
}

function anthropic(cfg: Settings): AIClient {
  return {
    provider: 'anthropic',
    async complete(req: CompletionRequest) {
      const data = await post(
        `${cfg.baseUrl}/v1/messages`,
        {
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        {
          model: cfg.model,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          // Thinking spends from max_tokens, so the answer keeps its 4096.
          ...(req.effort && effortKind(cfg) === 'anthropic'
            ? {
                max_tokens: 4096 + THINKING_BUDGET[req.effort],
                thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET[req.effort] },
              }
            : { max_tokens: 4096 }),
        },
      );
      // With thinking on, the first block is the thinking, not the answer.
      const text = (data.content as Array<{ type?: string; text?: unknown }> | undefined)?.find(
        (b) => b.type === 'text' || (b.type === undefined && typeof b.text === 'string'),
      )?.text;
      if (typeof text !== 'string') throw new AIError('Empty completion', true);
      return text;
    },
  };
}

function gemini(cfg: Settings): AIClient {
  return {
    provider: 'gemini',
    async complete(req: CompletionRequest) {
      const data = await post(
        `${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent`,
        { 'x-goog-api-key': cfg.apiKey },
        {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: {
            temperature: 0.2,
            ...(req.json ? { responseMimeType: 'application/json' } : {}),
            ...(req.effort && effortKind(cfg) === 'gemini'
              ? { thinkingConfig: { thinkingBudget: THINKING_BUDGET[req.effort] } }
              : {}),
          },
        },
      );
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== 'string') throw new AIError('Empty completion', true);
      return text;
    },
  };
}

/**
 * ChatGPT plan — the Responses API, not chat/completions.
 *
 * Spending a ChatGPT sign-in on the subscription reaches the backend Codex
 * talks to, and that backend serves `POST /responses` with `input` items. The
 * OpenAI-compatible client above would aim at a path it does not serve.
 */
function chatgptResponses(cfg: Settings): AIClient {
  return {
    provider: 'chatgpt',
    async complete(req: CompletionRequest) {
      const res = await fetchWithTimeout(`${cfg.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.oauth.accessToken}`,
          ...(cfg.oauth.accountId ? { 'chatgpt-account-id': cfg.oauth.accountId } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          // System text is its own field here, not a turn in the input.
          instructions: req.system,
          input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: req.user }] },
          ],
          stream: false,
          ...effortFields(cfg, req.effort),
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new AIError(
          `HTTP ${res.status}: ${text.slice(0, 300)}`,
          res.status === 429 || res.status >= 500,
        );
      }
      // The backend answers a non-stream request with a stream often enough
      // that both shapes have to be read.
      const content = text.trimStart().startsWith('data:')
        ? parseResponsesSSE(text)
        : readResponsesOutput(text);
      if (!content) throw new AIError('Empty completion', true);
      return content;
    },
  };
}

/** Text out of a Responses API body: `output[].content[].output_text`. */
export function readResponsesOutput(text: string): string {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AIError(`Respons bukan JSON: ${text.slice(0, 120)}`, true);
  }
  const out: string[] = [];
  for (const item of data.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') out.push(part.text);
    }
  }
  return out.join('');
}

/** The Responses stream is a typed event feed; only the text deltas are content. */
export function parseResponsesSSE(text: string): string {
  let out = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload);
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        out += event.delta;
      }
    } catch {
      /* keepalive / comment line */
    }
  }
  return out;
}

/**
 * Google Code Assist — the backend a Google sign-in reaches, what the Gemini
 * CLI talks to. Same GenerateContentRequest as the API-key Gemini client above,
 * wrapped in the Code Assist envelope and sent to an internal path.
 */
function codeAssist(cfg: Settings): AIClient {
  return {
    provider: 'google-codeassist',
    async complete(req: CompletionRequest) {
      const data = await post(
        `${cfg.baseUrl}/v1internal:generateContent`,
        {
          Authorization: `Bearer ${cfg.oauth.accessToken}`,
          'x-request-source': 'local',
        },
        {
          project: cfg.oauth.projectId,
          model: cfg.model,
          request: {
            systemInstruction: { parts: [{ text: req.system }] },
            contents: [{ role: 'user', parts: [{ text: req.user }] }],
            generationConfig: {
              temperature: 0.2,
              ...(req.json ? { responseMimeType: 'application/json' } : {}),
              ...(req.effort && effortKind(cfg) === 'gemini'
                ? { thinkingConfig: { thinkingBudget: THINKING_BUDGET[req.effort] } }
                : {}),
            },
          },
        },
      );
      // The envelope is sometimes unwrapped by the backend, sometimes not.
      const payload = data.response ?? data;
      const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== 'string' || !text) throw new AIError('Empty completion', true);
      return text;
    },
  };
}

/** Chrome built-in AI (Gemini Nano, Prompt API). Default when unconfigured. */
function builtin(): AIClient {
  return {
    provider: 'builtin',
    async complete(req: CompletionRequest) {
      const LM = (globalThis as any).LanguageModel;
      if (!LM?.create) {
        throw new AIError(
          t('pkg.ai.noBuiltin'),
          false,
        );
      }
      const session = await LM.create({
        initialPrompts: [{ role: 'system', content: req.system }],
      });
      try {
        return await session.prompt(req.user);
      } finally {
        session.destroy?.();
      }
    },
  };
}

export function createClient(settings: Settings): AIClient {
  const cfg = resolveConfig(settings);
  switch (cfg.provider) {
    case 'builtin':
      return builtin();
    case 'anthropic':
      return anthropic(cfg);
    case 'gemini':
      return gemini(cfg);
    case 'chatgpt':
      return chatgptResponses(cfg);
    case 'google-codeassist':
      return codeAssist(cfg);
    case 'azure':
      return azure(cfg);
    default:
      // openai | ollama | lmstudio | openrouter | custom
      return openAICompatible(cfg);
  }
}
