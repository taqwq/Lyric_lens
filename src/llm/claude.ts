/*
 * Claude (Anthropic API), tried before Gemini when the reader has saved a Claude key.
 *
 * Raw HTTP through the userscript transport (platform/http.ts), not the Anthropic SDK: the
 * request has to go out through GM_xmlhttpRequest like the Gemini one, and the script stays
 * one small bundle.
 *
 * Billing: the API draws on prepaid credit (on a Max plan, the monthly API credit). When the
 * credit is spent, Anthropic refuses the request ("credit balance is too low") and charges
 * nothing; Claude is then benched for a day and Gemini translates. Checking a key uses the
 * model list, which is free.
 */
import { getJSON, setJSON } from '../platform/storage';
import { streamRequest } from '../platform/http';
import { LLMError, retryAfterMs } from './errors';
import { SseParser } from './sse';
import type { GenerateRequest, GenerateResult } from './types';

export const CLAUDE_MODEL = 'claude-opus-5-5';
const CLAUDE_EFFORT = 'medium';
const CLAUDE_BASE = 'https://api.anthropic.com';
const API_VERSION = '2026-10-21';
/** Opus thinks before its first line; allow it longer than a Gemini model. */
const CLAUDE_FIRST_TEXT_TIMEOUT_MS = 90_000;
/** How long the model list may take, in either mode (a first connection can be slow). */
const PROBE_TIMEOUT_MS = 20_000;
/** Room for thinking, which counts against max_tokens. */
const THINKING_ROOM = 16_000;
const MAX_TOKENS = 128_000;

const CREDIT = /credit balance|billing|purchase credits/i;

/** Maps an Anthropic API failure to an error kind. A spent credit is 'quota'. */
export function classifyClaudeError(status: number, bodyText: string, rawHeaders = ''): LLMError {
  let body: { error?: { type?: string; message?: string } } | null = null;
  try { body = JSON.parse(bodyText); } catch { /* not JSON */ }
  const type = String(body?.error?.type ?? '');
  const message = String(body?.error?.message ?? (bodyText.slice(0, 300) || `HTTP ${status}`));
  const opts = { status, retryAfterMs: retryAfterMs(null, rawHeaders), detail: bodyText.slice(0, 4000) };
  if (CREDIT.test(message) || type === 'billing_error' || status === 402) return new LLMError('quota', 'ClaudeのAPIの残高がありません', opts);
  if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') return new LLMError('auth', message, opts);
  if (status === 429 || type === 'rate_limit_error') return new LLMError('rate', message, opts);
  if (status === 404 || type === 'not_found_error') return new LLMError('not-found', message, opts);
  if (status === 529 || status >= 500 || type === 'overloaded_error' || type === 'api_error') return new LLMError('overloaded', message, opts);
  if (status === 408 || type === 'timeout_error') return new LLMError('timeout', message, opts);
  if (status === 400 || status === 413 || type === 'invalid_request_error') return new LLMError('bad-request', message, opts);
  return new LLMError('unknown', message, opts);
}

/** Error event types inside a 200 stream, as the HTTP status they stand for. */
const EVENT_STATUS: Record<string, number> = { overloaded_error: 529, rate_limit_error: 429, api_error: 500, invalid_request_error: 400, authentication_error: 401, permission_error: 403, not_found_error: 404, billing_error: 402, timeout_error: 408 };

export class ClaudeProvider {
  constructor(private readonly apiKey: string) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey.trim(),
      'anthropic-version': API_VERSION,
      // Needed only where the request is a plain fetch (dev harness, tests); GM requests ignore CORS.
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  /** The model list: free (no tokens are used), so it serves to check the key and the transport. */
  private listModels(textMode: boolean, signal?: AbortSignal) {
    return streamRequest({ url: `${CLAUDE_BASE}/v1/models?limit=1`, method: 'GET', headers: this.headers(), signal, idleTimeoutMs: PROBE_TIMEOUT_MS, textMode });
  }

  /** Checks the key with the model list. Tampermonkey's stream mode was seen to deliver nothing
   *  from Anthropic, so a silent stream is retried in text mode, and the mode that answered is
   *  kept for translations. */
  async verify(signal?: AbortSignal): Promise<void> {
    let res;
    let textMode = false;
    try {
      res = await this.listModels(false, signal);
    } catch (error) {
      if (!(error instanceof LLMError) || error.kind !== 'timeout') throw error;
      console.info('[Lyric Lens] Claude: no answer in stream mode, trying text mode');
      textMode = true;
      res = await this.listModels(true, signal);
    }
    console.info('[Lyric Lens] Claude key check answered', { mode: textMode ? 'text' : 'stream', status: res.status });
    if (res.status < 200 || res.status >= 300) throw classifyClaudeError(res.status, res.text, res.headers);
    await saveMode(textMode);
  }

  /** Text mode shows nothing until the whole answer is in, so it is kept only while stream mode
   *  still fails: once a day, before a translation, stream mode is tried again on the free model
   *  list. Any answer at all (even an error status) means streams arrive again. */
  private async useTextMode(signal?: AbortSignal): Promise<boolean> {
    const mode = await loadMode();
    if (!mode.text || Date.now() - mode.at < RECHECK_MS) return mode.text;
    try {
      await this.listModels(false, signal);
      console.info('[Lyric Lens] Claude: stream mode answers again');
      await saveMode(false);
      return false;
    } catch (error) {
      if (error instanceof LLMError && error.kind === 'aborted') throw error;
      if (error instanceof LLMError && error.kind === 'timeout') await saveMode(true);
      return true;
    }
  }

  async generate(req: Omit<GenerateRequest, 'model'>): Promise<GenerateResult> {
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: Math.min(MAX_TOKENS, req.maxOutputTokens + THINKING_ROOM),
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: { effort: CLAUDE_EFFORT },
      stream: true,
    };
    const sse = new SseParser();
    let text = '';
    let stopReason = '';
    let streamError: LLMError | null = null;

    const handle = (payload: string) => {
      let data: { type?: string; delta?: { type?: string; text?: string; stop_reason?: string }; error?: { type?: string; message?: string } };
      try { data = JSON.parse(payload); } catch { return; }
      if (data.type === 'error') {
        streamError = classifyClaudeError(EVENT_STATUS[data.error?.type ?? ''] ?? 500, JSON.stringify(data));
        return;
      }
      if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta.text) {
        text += data.delta.text;
        req.onText(data.delta.text);
      }
      if (data.type === 'message_delta' && data.delta?.stop_reason) stopReason = data.delta.stop_reason;
    };

    const res = await streamRequest({
      textMode: await this.useTextMode(req.signal),
      url: `${CLAUDE_BASE}/v1/messages`,
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
      firstByteTimeoutMs: req.firstTextTimeoutMs ?? CLAUDE_FIRST_TEXT_TIMEOUT_MS,
      idleTimeoutMs: 120_000,
      onText: (chunk) => { for (const payload of sse.feed(chunk)) handle(payload); },
    });
    for (const payload of sse.flush()) handle(payload);

    if (res.status < 200 || res.status >= 300) throw classifyClaudeError(res.status, res.text, res.headers);
    if (streamError) throw streamError;
    if (!text && stopReason === 'refusal') throw new LLMError('blocked', 'Claudeがこのリクエストを拒否しました', { status: 200 });
    if (!text) throw new LLMError('empty', 'Claudeの応答が空でした', { status: 200, detail: res.text.slice(0, 2000) });
    const finish = stopReason === 'end_turn' ? 'stop' : stopReason === 'max_tokens' ? 'length' : stopReason === 'refusal' ? 'blocked' : 'unknown';
    return { finish, finishDetail: stopReason, text };
  }
}

/* ---------- how the manager delivers Anthropic's answers ---------- */

const MODE_KEY = 'll3:claude:text';
/** How long a failed stream-mode check stands before stream mode is tried again. */
const RECHECK_MS = 24 * 60 * 60_000;

interface Mode { text: boolean; at: number }

async function loadMode(): Promise<Mode> {
  try {
    const saved = await getJSON<unknown>(MODE_KEY, false);
    // Earlier versions stored a bare true: check stream mode again at once.
    if (saved === true) return { text: true, at: 0 };
    if (saved && typeof saved === 'object' && (saved as Mode).text === true) return { text: true, at: Number((saved as Mode).at) || 0 };
  } catch { /* advice only */ }
  return { text: false, at: 0 };
}

async function saveMode(text: boolean): Promise<void> {
  try { await setJSON(MODE_KEY, text ? { text: true, at: Date.now() } : false); } catch { /* advice only */ }
}

/* ---------- when Claude is skipped ---------- */

interface Bench { until: number; reason: string }
const BENCH_KEY = 'll3:claude';

/** Short fingerprint of the key, so a new key is not benched for the old one's failures. */
function tag(apiKey: string): string {
  let h = 0;
  for (const ch of apiKey.trim()) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

/** How long Claude is passed over after a failure (0 = try again on the next request). */
function benchFor(error: LLMError, now = Date.now()): number {
  switch (error.kind) {
    case 'quota': return now + 24 * 60 * 60_000;
    case 'auth': return now + 30 * 24 * 60 * 60_000;
    case 'rate': return now + Math.max(error.retryAfterMs, 60_000);
    case 'overloaded': return now + 2 * 60_000;
    case 'timeout': return now + 5 * 60_000;
    case 'unusable': return now + 10 * 60_000;
    case 'not-found': return now + 3 * 24 * 60 * 60_000;
    case 'bad-request': return now + 6 * 60 * 60_000;
    default: return 0;
  }
}

async function loadBench(): Promise<Record<string, Bench>> {
  try {
    const all = await getJSON<Record<string, Bench>>(BENCH_KEY, {});
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

/** Why Claude is passed over now, or null when it may be tried. */
export async function claudeBench(apiKey: string): Promise<Bench | null> {
  if (!apiKey.trim()) return null;
  const b = (await loadBench())[tag(apiKey)];
  return b && b.until > Date.now() ? b : null;
}

export async function benchClaude(apiKey: string, error: LLMError): Promise<void> {
  const until = benchFor(error);
  if (!until) return;
  try {
    const all = await loadBench();
    all[tag(apiKey)] = { until, reason: error.kind };
    await setJSON(BENCH_KEY, all);
  } catch { /* advice only */ }
}

/** A key saved again (or checked fine) starts with a clean slate. */
export async function clearClaudeBench(apiKey: string): Promise<void> {
  try {
    const all = await loadBench();
    if (!(tag(apiKey) in all)) return;
    delete all[tag(apiKey)];
    await setJSON(BENCH_KEY, all);
  } catch { /* advice only */ }
}
