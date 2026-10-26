import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCooldowns,
  cooldownId,
  generateWithFallback,
  isUsable,
  keyStatus,
  keyTag,
  markKey,
  nextPacificMidnight,
  type ChainResult,
} from '../src/llm/chain';
import { LLMError } from '../src/llm/errors';
import type { HttpResult, StreamRequest } from '../src/platform/http';
import { streamRequest } from '../src/platform/http';
import { getJSON, memoryStorage, setJSON, setKV } from '../src/platform/storage';
import { newProvider } from '../src/store/settings';
import type { ProviderConfig } from '../src/llm/types';

vi.mock('../src/platform/http', () => ({ streamRequest: vi.fn() }));

const http = vi.mocked(streamRequest);

/* ---------- scripted Gemini / OpenAI-compatible endpoints ---------- */

const A = 'gemini-3.5-flash'; // rank 1035
const B = 'gemini-2.5-flash'; // rank 1025
const C = 'gemini-3.5-flash-lite'; // rank 135
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

const MODEL_LIST = {
  models: [A, B, C].map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })),
};

type Reply =
  | { status: number; body: string }
  | { throws: LLMError; partial?: string };

const queues = new Map<string, Reply[]>();
/** Every generation request, by model, in order. Model-list requests are not included. */
let generated: string[] = [];
/** The API key each generation request carried, parallel to `generated`. */
let generatedKeys: string[] = [];
let listReply: Reply = { status: 200, body: JSON.stringify(MODEL_LIST) };

function reply(model: string, ...replies: Reply[]): void {
  queues.set(model, [...(queues.get(model) ?? []), ...replies]);
}

async function serve(req: StreamRequest): Promise<HttpResult> {
  let model: string;
  let next: Reply | undefined;
  if (req.url.includes('/v1beta/models?') || (req.method === 'GET' && req.url.endsWith('/models'))) {
    next = listReply;
    model = '(list)';
  } else {
    const gemini = /models\/([^:]+):streamGenerateContent/.exec(req.url);
    if (gemini) model = decodeURIComponent(gemini[1]!);
    else if (req.url.endsWith('/chat/completions')) model = (JSON.parse(req.body ?? '{}') as { model: string }).model;
    else throw new Error(`unexpected URL ${req.url}`);
    generated.push(model);
    generatedKeys.push(req.headers?.['x-goog-api-key'] ?? req.headers?.Authorization?.replace(/^Bearer /, '') ?? '');
    next = queues.get(model)?.shift();
  }
  if (!next) throw new Error(`no scripted reply left for ${model}`);
  if ('throws' in next) {
    if (next.partial) req.onText?.(next.partial);
    throw next.throws;
  }
  // Like the real transport: the body (even an error body) is pushed through onText in small pieces.
  for (let i = 0; i < next.body.length; i += 37) req.onText?.(next.body.slice(i, i + 37));
  return { status: next.status, text: next.body, headers: '' };
}

const ev = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const textEvent = (text: string, part: Record<string, unknown> = {}) => ev({ candidates: [{ content: { parts: [{ text, ...part }] } }] });
const stopEvent = (reason = 'STOP') => ev({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: reason }] });
const ok = (text: string): Reply => ({ status: 200, body: textEvent(text) + stopEvent() });

const googleError = (code: number, status: string, message: string, details?: unknown): Reply => ({
  status: code,
  body: JSON.stringify({ error: { code, status, message, ...(details ? { details } : {}) } }),
});
const busy = () => googleError(503, 'UNAVAILABLE', 'This model is currently experiencing high demand.');
const unauthorized = () => googleError(401, 'UNAUTHENTICATED', 'API key not valid. Please pass a valid API key.');
const dailyQuota = () => googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please check your plan and billing details.', [
  {
    '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
  },
]);
const rateLimited = (retryDelay: string) => googleError(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).', [
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
]);

const COOLDOWNS = 'll3:cooldowns';
const readCooldowns = () => getJSON<Record<string, { until: number; reason: string }>>(COOLDOWNS, {});

const gemini = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({ ...newProvider('gemini', 'test-key'), ...overrides });
/** Cooldowns are kept per preset, endpoint, API key and model. */
const cooldownKey = (model: string, config: ProviderConfig = gemini()) => cooldownId(config, model);

type StoredCooldowns = Record<string, { until: number; reason: string }>;
const seedCooldowns = (entries: StoredCooldowns) => setJSON(COOLDOWNS, entries);
/** Pre-seeds the model list a provider would otherwise fetch, so no request is made for it. */
const seedModels = (config: ProviderConfig, ...ids: string[]) =>
  setJSON(`ll3:models:${cooldownId(config, '')}`, { at: Date.now(), models: ids.map((m, i) => ({ id: m, label: m, rank: 100 - i })) });

interface Run {
  chunks: string[];
  statuses: string[];
  promise: Promise<ChainResult>;
}

/** `verdict` is what the consumer's onText answers for a chunk (chunks so far, including this one);
 *  by default it gives no verdict, like a consumer written before verdicts existed. */
function start(configs: ProviderConfig[], signal?: AbortSignal, verdict?: (chunks: string[]) => boolean | void): Run {
  const chunks: string[] = [];
  const statuses: string[] = [];
  const promise = generateWithFallback(
    configs,
    {
      system: 'sys', user: 'usr', maxOutputTokens: 1000, thinking: 'low',
      onText: (t) => { chunks.push(t); return verdict?.(chunks); },
    },
    { onStatus: (s) => statuses.push(s), signal },
  );
  return { chunks, statuses, promise };
}

/** Awaits the outcome without letting a rejection go unhandled while fake timers are advancing. */
function settle(run: Run): Promise<{ result?: ChainResult; error?: LLMError }> {
  return run.promise.then((result) => ({ result }), (error: LLMError) => ({ error }));
}

beforeEach(() => {
  setKV(memoryStorage());
  http.mockReset();
  http.mockImplementation(serve);
  queues.clear();
  generated = [];
  generatedKeys = [];
  listReply = { status: 200, body: JSON.stringify(MODEL_LIST) };
});

afterEach(() => {
  vi.useRealTimers();
});

/* ---------- tests ---------- */

describe('generateWithFallback: model fallback', () => {
  it('moves on to the next model when the first is busy (503) and says so', async () => {
    reply(A, busy());
    reply(B, ok('L1: あ\n'));
    const run = start([gemini()]);
    const result = await run.promise;

    expect(generated).toEqual([A, B]);
    expect(result.model).toBe(B);
    expect(result.provider).toBe('Google Gemini');
    expect(result.finish).toBe('stop');
    expect(result.text).toBe('L1: あ\n');
    expect(run.chunks.join('')).toBe('L1: あ\n');
    expect(run.statuses.some((s) => s.includes('混雑'))).toBe(true);
    expect(run.statuses[0]).toBe('Google Gemini · 3.5-flash');
    expect(run.statuses).toContain('Google Gemini · 2.5-flash');
  });

  it('does not feed an error body to onText', async () => {
    reply(A, busy());
    reply(B, ok('L1: あ\n'));
    const run = start([gemini()]);
    await run.promise;
    expect(run.chunks).toEqual(['L1: あ\n']);
  });

  it('remembers a busy model for two minutes and tries it last next time', async () => {
    reply(A, busy());
    reply(B, ok('L1: あ\n'));
    await start([gemini()]).promise;
    const cooldowns = await readCooldowns();
    expect(cooldowns[cooldownKey(A)]?.reason).toBe('overloaded');
    expect(cooldowns[cooldownKey(A)]!.until - Date.now()).toBeGreaterThan(60_000);
    expect(cooldowns[cooldownKey(A)]!.until - Date.now()).toBeLessThanOrEqual(120_000);
    expect(cooldowns[cooldownKey(B)]).toBeUndefined();

    generated = [];
    reply(B, busy());
    reply(C, ok('L1: い\n'));
    const second = await start([gemini()]).promise;
    expect(generated).toEqual([B, C]); // A was demoted to the end and never needed
    expect(second.model).toBe(C);
  });

  it('uses the pinned model only, without listing models', async () => {
    reply(C, ok('L1: う\n'));
    const result = await start([gemini({ model: C })]).promise;
    expect(result.model).toBe(C);
    expect(generated).toEqual([C]);
    expect(http.mock.calls.some(([r]) => r.url.includes('/v1beta/models?'))).toBe(false);
  });

  it('falls back to a built-in model list when listing fails for a non-auth reason', async () => {
    listReply = { status: 500, body: 'internal error' };
    reply('gemini-3.8-flash', ok('L1: え\n'));
    const result = await start([gemini()]).promise;
    expect(result.model).toBe('gemini-3.8-flash');
  });

  it('lists models for an OpenAI-compatible provider and tries the best-ranked ones', async () => {
    listReply = { status: 200, body: JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-versatile' }, { id: 'openai/gpt-oss-120b' }] }) };
    reply('openai/gpt-oss-120b', busy());
    reply('llama-3.3-70b-versatile', {
      status: 200,
      body: ev({ choices: [{ delta: { content: 'L1: え\n' }, finish_reason: 'stop' }] }),
    });
    const result = await start([newProvider('groq', 'gk')]).promise;
    expect(generated).toEqual(['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']); // whisper is excluded, gpt-oss ranks first
    expect(result.model).toBe('llama-3.3-70b-versatile');
  });

  // candidateModels() swallows a failed model listing and returns [] for non-Gemini providers,
  // no error is recorded, and the chain finally throws the default "API key not set" auth error.
  // A Groq/Ollama outage therefore looks like a missing key.
  it('does not report a failed model listing as a missing API key', async () => {
    listReply = { status: 500, body: 'internal error' };
    const { error } = await settle(start([newProvider('groq', 'gk')]));
    expect(error).toBeInstanceOf(LLMError);
    expect(error?.kind).not.toBe('auth');
  });

  it('reports an auth error from the model list without trying any model', async () => {
    listReply = unauthorized();
    const { error } = await settle(start([gemini()]));
    expect(error?.kind).toBe('auth');
    expect(generated).toEqual([]);
  });

  it('returns finish "length" for MAX_TOKENS so the caller can report the cut', async () => {
    reply(A, { status: 200, body: textEvent('L1: あ\n') + stopEvent('MAX_TOKENS') });
    const result = await start([gemini()]).promise;
    expect(result.finish).toBe('length');
    expect(result.text).toBe('L1: あ\n');
  });

  it('never forwards thought parts to onText', async () => {
    reply(A, {
      status: 200,
      body: textEvent('Let me think about slang…', { thought: true }) + textEvent('L1: ') + textEvent('あ\n') + textEvent('more thinking', { thought: true }) + stopEvent(),
    });
    const run = start([gemini()]);
    const result = await run.promise;
    expect(run.chunks).toEqual(['L1: ', 'あ\n']);
    expect(result.text).toBe('L1: あ\n');
    expect(JSON.stringify(run.chunks)).not.toContain('think');
  });
});

describe('generateWithFallback: quota cooldowns', () => {
  it('stores a daily-quota cooldown and skips that model on the next call without requesting it', async () => {
    reply(A, dailyQuota());
    reply(B, ok('L1: あ\n'));
    const first = start([gemini()]);
    await first.promise;
    expect(generated).toEqual([A, B]);
    expect(first.statuses.some((s) => s.includes('今日の上限'))).toBe(true);

    const cooldown = (await readCooldowns())[cooldownKey(A)]!;
    expect(cooldown.reason).toBe('quota');
    expect(cooldown.until - Date.now()).toBeGreaterThan(0);
    expect(cooldown.until - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 120_000);

    generated = [];
    reply(B, ok('L1: い\n'));
    const second = await start([gemini()]).promise;
    expect(generated).toEqual([B]); // A is not requested at all
    expect(second.model).toBe(B);
  });

  it('throws a quota error, and then a "all at the limit" error without any request', async () => {
    reply(A, dailyQuota());
    reply(B, dailyQuota());
    reply(C, dailyQuota());
    const first = await settle(start([gemini()]));
    expect(first.error?.kind).toBe('quota');
    expect(generated).toEqual([A, B, C]);

    generated = [];
    const second = await settle(start([gemini()]));
    expect(second.error?.kind).toBe('quota');
    expect(second.error?.status).toBe(429);
    expect(second.error?.message).toContain('上限');
    expect(generated).toEqual([]);
  });

  it('does not skip a model the user pinned, even when a cooldown is stored', async () => {
    reply(A, dailyQuota());
    const first = await settle(start([gemini({ model: A })]));
    expect(first.error?.kind).toBe('quota');

    reply(A, ok('L1: あ\n'));
    const second = await start([gemini({ model: A })]).promise;
    expect(second.model).toBe(A);
    expect(generated).toEqual([A, A]);
  });

  it('clearCooldowns() makes skipped models eligible again', async () => {
    reply(A, dailyQuota());
    reply(B, ok('L1: あ\n'));
    await start([gemini()]).promise;
    await clearCooldowns();
    generated = [];
    reply(A, ok('L1: い\n'));
    const result = await start([gemini()]).promise;
    expect(generated).toEqual([A]);
    expect(result.model).toBe(A);
  });

  it('parks a per-minute limit with a long retry delay for at least that long, without waiting', async () => {
    reply(A, rateLimited('120s'));
    reply(B, ok('L1: あ\n'));
    const run = start([gemini()]);
    const result = await run.promise;
    expect(generated).toEqual([A, B]);
    expect(result.model).toBe(B);
    const cooldown = (await readCooldowns())[cooldownKey(A)]!;
    expect(cooldown.reason).toBe('rate');
    expect(cooldown.until - Date.now()).toBeGreaterThan(100_000);
    expect(run.statuses.some((s) => s.includes('回数制限'))).toBe(true);
  });

  it('remembers a missing model (404) for days', async () => {
    reply(A, googleError(404, 'NOT_FOUND', 'models/gemini-3.5-flash is not found for API version v1beta'));
    reply(B, ok('L1: あ\n'));
    await start([gemini()]).promise;
    const cooldown = (await readCooldowns())[cooldownKey(A)]!;
    expect(cooldown.reason).toBe('not-found');
    expect(cooldown.until - Date.now()).toBeGreaterThan(2 * 24 * 3600_000);
  });
});

describe('generateWithFallback: when every candidate is cooling down', () => {
  const openrouter = () => newProvider('openrouter', 'ork');
  const groq = () => newProvider('groq', 'gk');
  const FREE = ['vendor/one:free', 'vendor/two:free', 'vendor/three:free'];

  it('reports a per-minute wait as "rate", not as the daily quota, without any request', async () => {
    const config = openrouter();
    await seedModels(config, ...FREE);
    const until = Date.now() + 60_000;
    await seedCooldowns(Object.fromEntries(FREE.map((m) => [cooldownId(config, m), { until, reason: 'rate' }])));

    const { error } = await settle(start([config]));
    expect(error).toBeInstanceOf(LLMError);
    expect(error?.kind).toBe('rate');
    expect(error?.retryAfterMs).toBeGreaterThan(0);
    expect(error?.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(error?.status).toBe(429);
    expect(http).not.toHaveBeenCalled();
  });

  it('reports the real reset: the earliest quota cooldown across providers', async () => {
    const g = gemini();
    const q = groq();
    await seedModels(g, A, B, C);
    await seedModels(q, 'groq-model');
    const now = Date.now();
    await seedCooldowns({
      ...Object.fromEntries([A, B, C].map((m) => [cooldownId(g, m), { until: now + 10 * 3600_000, reason: 'quota' }])),
      [cooldownId(q, 'groq-model')]: { until: now + 3 * 3600_000, reason: 'quota' },
    });

    const { error } = await settle(start([g, q]));
    expect(error?.kind).toBe('quota');
    expect(Math.abs(error!.retryAfterMs - 3 * 3600_000)).toBeLessThan(5_000); // Groq's, not Gemini's later one
    expect(http).not.toHaveBeenCalled();
  });

  it('a quota wait is always reported above one minute, so it is read as a reset time', async () => {
    const g = gemini();
    await seedModels(g, A);
    await seedCooldowns({ [cooldownId(g, A)]: { until: Date.now() + 5_000, reason: 'quota' } });
    const { error } = await settle(start([g]));
    expect(error?.kind).toBe('quota');
    expect(error?.retryAfterMs).toBeGreaterThan(60_000);
  });

  it('a short rate cooldown on one provider beats a longer quota cooldown on another', async () => {
    const g = gemini();
    const q = groq();
    await seedModels(g, A, B, C);
    await seedModels(q, 'groq-model');
    const now = Date.now();
    await seedCooldowns({
      ...Object.fromEntries([A, B, C].map((m) => [cooldownId(g, m), { until: now + 10 * 3600_000, reason: 'quota' }])),
      [cooldownId(q, 'groq-model')]: { until: now + 30_000, reason: 'rate' },
    });

    const { error } = await settle(start([g, q]));
    expect(error?.kind).toBe('rate');
    expect(error?.retryAfterMs).toBeGreaterThan(20_000);
    expect(error?.retryAfterMs).toBeLessThanOrEqual(30_000);
    expect(http).not.toHaveBeenCalled();
  });

  it('ignores missing-model cooldowns when naming the wait', async () => {
    const g = gemini();
    await seedModels(g, A, B, C);
    const until = Date.now() + 3 * 24 * 3600_000;
    await seedCooldowns(Object.fromEntries([A, B, C].map((m) => [cooldownId(g, m), { until, reason: 'not-found' }])));
    const { error } = await settle(start([g]));
    expect(error?.kind).toBe('quota'); // as before: nothing better to say
    expect(error?.retryAfterMs).toBe(0);
    expect(error?.message).toContain('上限');
    expect(http).not.toHaveBeenCalled();
  });

  it('a real quota error carries the reset time recorded in the cooldown table', async () => {
    reply(A, dailyQuota());
    reply(B, dailyQuota());
    reply(C, dailyQuota());
    const { error } = await settle(start([gemini()]));
    expect(error?.kind).toBe('quota');
    expect(error?.model).toBe(A);
    expect(error?.provider).toBe('Google Gemini');
    const soonest = Math.min(...Object.values(await readCooldowns()).map((c) => c.until));
    expect(error!.retryAfterMs).toBeGreaterThan(60_000);
    expect(Math.abs(error!.retryAfterMs - (soonest - Date.now()))).toBeLessThan(5_000);
  });

  it('a real quota error turns into a short "rate" wait when another provider returns within a minute', async () => {
    const g = gemini();
    const q = groq();
    await seedModels(q, 'groq-model');
    await seedCooldowns({ [cooldownId(q, 'groq-model')]: { until: Date.now() + 45_000, reason: 'rate' } });
    reply(A, dailyQuota());
    reply(B, dailyQuota());
    reply(C, dailyQuota());

    const { error } = await settle(start([g, q]));
    expect(generated).toEqual([A, B, C]); // Groq is skipped, not tried
    expect(error?.kind).toBe('rate');
    expect(error?.retryAfterMs).toBeGreaterThan(30_000);
    expect(error?.retryAfterMs).toBeLessThanOrEqual(45_000);
  });

  it('passes an error that is not a quota error through unchanged', async () => {
    reply(B, googleError(400, 'INVALID_ARGUMENT', 'bad field'));
    const { error } = await settle(start([gemini({ model: B })]));
    expect(error?.kind).toBe('bad-request');
    expect(error?.retryAfterMs).toBe(0);
    expect(error?.status).toBe(400);
  });
});

describe('generateWithFallback: the cooldown table follows what happened', () => {
  it('forgets a benched model once it answers, in storage as well as in memory', async () => {
    await seedCooldowns({ [cooldownKey(A)]: { until: Date.now() + 120_000, reason: 'overloaded' } });
    reply(B, googleError(400, 'INVALID_ARGUMENT', 'bad field'));
    reply(C, googleError(400, 'INVALID_ARGUMENT', 'bad field'));
    reply(A, ok('L1: あ\n'));
    const first = await start([gemini()]).promise;
    expect(generated).toEqual([B, C, A]); // the benched model goes last
    expect(first.model).toBe(A);
    expect(await readCooldowns()).toEqual({});

    generated = [];
    reply(A, ok('L1: い\n'));
    await start([gemini()]).promise;
    expect(generated).toEqual([A]); // first in line again
  });

  it('keeps the other entries when one model recovers', async () => {
    await seedCooldowns({
      [cooldownKey(A)]: { until: Date.now() + 120_000, reason: 'overloaded' },
      [cooldownKey(C)]: { until: Date.now() + 3600_000, reason: 'quota' },
    });
    reply(B, googleError(400, 'INVALID_ARGUMENT', 'bad field'));
    reply(A, ok('L1: あ\n'));
    await start([gemini()]).promise;
    expect(Object.keys(await readCooldowns())).toEqual([cooldownKey(C)]);
  });

  it('benches a model that broke after streaming text, so the next tap does not go back to it', async () => {
    reply(A, {
      status: 200,
      body: textEvent('L1: あ\n') + ev({ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } }),
    });
    const first = await start([gemini()]).promise;
    expect(first.error?.kind).toBe('overloaded');
    expect(first.model).toBe(A);
    expect(generated).toEqual([A]);
    const cooldown = (await readCooldowns())[cooldownKey(A)];
    expect(cooldown?.reason).toBe('overloaded');
    expect(cooldown!.until - Date.now()).toBeGreaterThan(60_000);

    generated = [];
    reply(B, ok('L1: い\n'));
    const second = await start([gemini()]).promise;
    expect(generated).toEqual([B]); // A was demoted to the end
    expect(second.model).toBe(B);
  });

  it('skips a model that hit a per-minute limit mid-stream until the limit has passed', async () => {
    reply(A, { partial: textEvent('L1: あ\n'), throws: new LLMError('rate', 'slow down', { status: 429, retryAfterMs: 5_000 }) });
    const first = await start([gemini()]).promise;
    expect(first.error?.kind).toBe('rate');
    expect((await readCooldowns())[cooldownKey(A)]?.reason).toBe('rate');

    generated = [];
    reply(B, ok('L1: い\n'));
    await start([gemini()]).promise;
    expect(generated).toEqual([B]);
  });

  it('does not bench a model whose stream merely dropped', async () => {
    reply(A, { partial: textEvent('L1: あ\n'), throws: new LLMError('network', 'down') });
    await start([gemini()]).promise;
    expect(await readCooldowns()).toEqual({});
  });
});

describe('OpenAI-compatible providers: reasoning effort', () => {
  const REPLY: Reply = { status: 200, body: ev({ choices: [{ delta: { content: 'L1: あ\n' }, finish_reason: 'stop' }] }) };
  const reject = (message: string): Reply => ({ status: 400, body: JSON.stringify({ error: { message, type: 'invalid_request_error' } }) });
  const pinned = (preset: string, model: string): ProviderConfig => ({ ...newProvider(preset, 'k'), model });
  const bodies = () =>
    http.mock.calls.map(([r]) => r).filter((r) => r.url.endsWith('/chat/completions')).map((r) => JSON.parse(r.body ?? '{}') as Record<string, unknown>);

  it('sends the thinking level to gpt-oss on Groq and Cerebras', async () => {
    reply('openai/gpt-oss-120b', REPLY);
    reply('gpt-oss-120b', REPLY);
    await start([pinned('groq', 'openai/gpt-oss-120b')]).promise; // start() thinks at "low"
    await start([pinned('cerebras', 'gpt-oss-120b')]).promise;
    expect(bodies().map((b) => b.reasoning_effort)).toEqual(['low', 'low']);
  });

  it('follows the reader\'s level, not a fixed one', async () => {
    reply('openai/gpt-oss-120b', REPLY);
    await generateWithFallback(
      [pinned('groq', 'openai/gpt-oss-120b')],
      { system: 's', user: 'u', maxOutputTokens: 100, thinking: 'high', onText: () => undefined },
    );
    expect(bodies()[0]?.reasoning_effort).toBe('high');
  });

  it('leaves other models and endpoints alone', async () => {
    reply('llama-3.3-70b-versatile', REPLY);
    reply('openai/gpt-oss-120b:free', REPLY);
    reply('gpt-oss:20b', REPLY);
    await start([pinned('groq', 'llama-3.3-70b-versatile')]).promise;
    await start([pinned('openrouter', 'openai/gpt-oss-120b:free')]).promise;
    await start([pinned('ollama', 'gpt-oss:20b')]).promise;
    const sent = bodies();
    expect(sent).toHaveLength(3);
    for (const body of sent) expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('retries once without the field when the endpoint rejects it', async () => {
    reply('openai/gpt-oss-120b', reject("Unsupported parameter: 'reasoning_effort' is not supported with this model."), REPLY);
    const result = await start([pinned('groq', 'openai/gpt-oss-120b')]).promise;
    expect(result.model).toBe('openai/gpt-oss-120b');
    expect(result.text).toBe('L1: あ\n');
    const sent = bodies();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.reasoning_effort).toBe('low');
    expect(sent[1]).not.toHaveProperty('reasoning_effort');
  });

  it('does not retry forever: a second rejection that mentions reasoning is an error', async () => {
    reply('openai/gpt-oss-120b', reject('reasoning_effort is invalid'), reject('reasoning is not supported'));
    const { error } = await settle(start([pinned('groq', 'openai/gpt-oss-120b')]));
    expect(error?.kind).toBe('bad-request');
    expect(bodies()).toHaveLength(2);
  });

  it('still flips the token parameter name, and can do both in one call', async () => {
    reply(
      'openai/gpt-oss-120b',
      reject("Unsupported parameter: 'max_completion_tokens'. Use 'max_tokens' instead."),
      reject("Unknown parameter: 'reasoning_effort'."),
      REPLY,
    );
    const result = await start([pinned('groq', 'openai/gpt-oss-120b')]).promise;
    expect(result.text).toBe('L1: あ\n');
    const sent = bodies();
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ max_completion_tokens: 1000, reasoning_effort: 'low' });
    expect(sent[1]).toMatchObject({ max_tokens: 1000, reasoning_effort: 'low' });
    expect(sent[2]).toMatchObject({ max_tokens: 1000 });
    expect(sent[2]).not.toHaveProperty('reasoning_effort');
    expect(sent[2]).not.toHaveProperty('max_completion_tokens');
  });

  it('does not retry an unrelated bad request', async () => {
    reply('openai/gpt-oss-120b', reject('messages: content must be a string'));
    const { error } = await settle(start([pinned('groq', 'openai/gpt-oss-120b')]));
    expect(error?.kind).toBe('bad-request');
    expect(bodies()).toHaveLength(1);
  });
});

describe('cooldown ids and API keys', () => {
  it('cooldownId is preset, endpoint, key fingerprint and model', () => {
    const config = gemini();
    expect(cooldownId(config, 'm')).toBe(`gemini:${GEMINI_BASE}:${keyTag(config)}:m`);
    expect(cooldownId(config, '')).toBe(`gemini:${GEMINI_BASE}:${keyTag(config)}:`);
    expect(cooldownId({ ...config, baseUrl: 'https://proxy.example' }, 'm')).toBe(`gemini:https://proxy.example:${keyTag(config)}:m`);
  });

  it('keyTag is stable, ignores surrounding whitespace, tells keys apart, and does not contain the key', () => {
    expect(keyTag(gemini())).toBe(keyTag(gemini()));
    expect(keyTag(gemini({ apiKey: '  test-key \n' }))).toBe(keyTag(gemini()));
    expect(keyTag(gemini({ apiKey: 'another-key' }))).not.toBe(keyTag(gemini()));
    expect(keyTag(gemini({ apiKey: 'test-kez' }))).not.toBe(keyTag(gemini()));
    expect(keyTag(gemini({ apiKey: 'AIzaSyEXAMPLEKEYEXAMPLEKEY' }))).not.toContain('AIza');
    expect(cooldownId(gemini({ apiKey: 'AIzaSyEXAMPLEKEYEXAMPLEKEY' }), 'm')).not.toContain('AIzaSyEXAMPLE');
  });

  it('stores a cooldown under the id of the key that hit the limit', async () => {
    const config = gemini({ apiKey: 'key-one' });
    reply(A, dailyQuota());
    reply(B, ok('L1: あ\n'));
    await start([config]).promise;
    const stored = await readCooldowns();
    expect(Object.keys(stored)).toEqual([cooldownId(config, A)]);
    expect(stored[cooldownKey(A, config)]?.reason).toBe('quota');
    expect(stored[cooldownKey(A, gemini({ apiKey: 'key-two' }))]).toBeUndefined();
  });

  it("still tries a second Gemini key after the first key's models are all in quota cooldown", async () => {
    const first = gemini({ apiKey: 'key-one' });
    const second = gemini({ id: 'gemini-2', apiKey: 'key-two' });
    reply(A, dailyQuota());
    reply(B, dailyQuota());
    reply(C, dailyQuota());
    expect((await settle(start([first]))).error?.kind).toBe('quota');
    expect(generatedKeys).toEqual(['key-one', 'key-one', 'key-one']);

    // the first key is spent for today; the second is another project with its own quota
    generated = [];
    generatedKeys = [];
    reply(A, ok('L1: あ\n'));
    const run = start([first, second]);
    const result = await run.promise;
    expect(result.model).toBe(A);
    expect(generated).toEqual([A]);
    expect(generatedKeys).toEqual(['key-two']); // nothing was spent on key-one
    expect(run.chunks.join('')).toBe('L1: あ\n');
    const stored = await readCooldowns();
    expect(Object.keys(stored).sort()).toEqual([A, B, C].map((m) => cooldownId(first, m)).sort());
  });

  it('keeps a spent key skipped when another provider entry carries the same key', async () => {
    const first = gemini({ apiKey: 'key-one' });
    reply(A, dailyQuota());
    reply(B, dailyQuota());
    reply(C, dailyQuota());
    await settle(start([first]));

    generated = [];
    const again = await settle(start([gemini({ id: 'gemini-again', apiKey: 'key-one' })]));
    expect(again.error?.kind).toBe('quota');
    expect(again.error?.message).toContain('上限');
    expect(generated).toEqual([]);
  });

  it('keeps the model list per key too', async () => {
    const first = gemini({ apiKey: 'key-one' });
    const second = gemini({ id: 'gemini-2', apiKey: 'key-two' });
    reply(A, ok('L1: あ\n'), ok('L1: い\n'), ok('L1: う\n'));
    await start([first]).promise;
    await start([second]).promise;
    const listRequests = () => http.mock.calls.filter(([r]) => r.url.includes('/v1beta/models?'));
    expect(listRequests()).toHaveLength(2);
    expect(listRequests().map(([r]) => r.headers?.['x-goog-api-key'])).toEqual(['key-one', 'key-two']);
    expect((await getJSON<{ models: unknown[] } | null>(`ll3:models:${cooldownId(first, '')}`, null))?.models).toHaveLength(3);
    expect((await getJSON<{ models: unknown[] } | null>(`ll3:models:${cooldownId(second, '')}`, null))?.models).toHaveLength(3);

    // a key that is already listed is not listed again
    await start([first]).promise;
    expect(listRequests()).toHaveLength(2);
  });
});

describe('generateWithFallback: auth', () => {
  it('throws kind "auth" on 401 and does not try the provider\'s other models', async () => {
    reply(A, unauthorized());
    reply(B, ok('L1: あ\n'));
    const { error } = await settle(start([gemini()]));
    expect(error).toBeInstanceOf(LLMError);
    expect(error?.kind).toBe('auth');
    expect(error?.model).toBe(A);
    expect(error?.provider).toBe('Google Gemini');
    expect(generated).toEqual([A]);
    expect(await readCooldowns()).toEqual({}); // a bad key is not a cooldown
  });

  it('remembers a rejected key: keyStatus reports "bad" for that key only', async () => {
    const config = gemini();
    expect(await keyStatus(config)).toEqual({ kind: 'ok' });
    reply(A, unauthorized());
    await settle(start([config]));

    expect(await keyStatus(config)).toEqual({ kind: 'bad' });
    expect(await keyStatus({ ...config, id: 'elsewhere' })).toEqual({ kind: 'bad' }); // same key, wherever it is configured
    expect(await keyStatus(gemini({ apiKey: 'a-different-key' }))).toEqual({ kind: 'ok' });
    expect(await keyStatus(gemini({ apiKey: '   ' }))).toEqual({ kind: 'missing' });
  });

  it('markKey(config, true) condemns a key and markKey(config, false) forgives it', async () => {
    const config = gemini();
    await markKey(config, true);
    expect(await keyStatus(config)).toEqual({ kind: 'bad' });
    await markKey(config, false);
    expect(await keyStatus(config)).toEqual({ kind: 'ok' });
  });

  it('does not mark the key bad for failures that are not about the key', async () => {
    const config = gemini();
    reply(A, busy());
    reply(B, dailyQuota());
    reply(C, googleError(400, 'INVALID_ARGUMENT', 'bad field'));
    await settle(start([config]));
    expect((await keyStatus(config)).kind).not.toBe('bad');
  });

  it('keyStatus reports "resting" with the earliest reset when every model is out of quota', async () => {
    const config = gemini();
    reply(A, dailyQuota());
    reply(B, dailyQuota());
    reply(C, dailyQuota());
    await settle(start([config]));
    const status = await keyStatus(config);
    expect(status.kind).toBe('resting');
    const stored = await readCooldowns();
    expect(status.kind === 'resting' && status.until).toBe(Math.min(...Object.values(stored).map((c) => c.until)));
  });

  // The key is just as invalid when the rejection comes from the model-list request that precedes
  // generation (the usual place for a revoked key, since automatic model choice lists first), but
  // only the generation path calls markKey (src/llm/chain.ts:243-248 versus :321-324). The settings
  // sheet then keeps showing the key as fine, because keyStatus relies on that mark.
  it('also remembers a key that was rejected by the model-list request', async () => {
    listReply = unauthorized();
    const config = gemini();
    const { error } = await settle(start([config]));
    expect(error?.kind).toBe('auth');
    expect(await keyStatus(config)).toEqual({ kind: 'bad' });
  });

  it('moves on to the next provider after an auth failure', async () => {
    reply(A, unauthorized());
    reply('llama-3.3-70b-versatile', {
      status: 200,
      body: ev({ choices: [{ delta: { content: '<think>hmm</think>L1: ' }, finish_reason: null }] })
        + ev({ choices: [{ delta: { content: 'う\n' }, finish_reason: null }] })
        + ev({ choices: [{ delta: {}, finish_reason: 'stop' }] })
        + 'data: [DONE]\n\n',
    });
    const groq = { ...newProvider('groq', 'gk'), model: 'llama-3.3-70b-versatile' };
    const run = start([gemini(), groq]);
    const result = await run.promise;
    expect(generated).toEqual([A, 'llama-3.3-70b-versatile']);
    expect(result.provider).toBe('Groq');
    expect(result.model).toBe('llama-3.3-70b-versatile');
    expect(result.finish).toBe('stop');
    expect(run.chunks.join('')).toBe('L1: う\n');
  });

  it('throws an auth error without any request when no provider is usable', async () => {
    const disabled = gemini({ enabled: false });
    const noKey = newProvider('gemini', '   ');
    const { error } = await settle(start([disabled, noKey]));
    expect(error?.kind).toBe('auth');
    expect(http).not.toHaveBeenCalled();
  });

  it('isUsable checks enabled, key, and base URL', () => {
    expect(isUsable(gemini())).toBe(true);
    expect(isUsable(gemini({ enabled: false }))).toBe(false);
    expect(isUsable(gemini({ apiKey: '  ' }))).toBe(false);
    expect(isUsable(newProvider('ollama'))).toBe(true); // no key needed
    expect(isUsable(newProvider('custom'))).toBe(false); // no base URL
    expect(isUsable({ ...newProvider('custom'), baseUrl: 'http://localhost:1234/v1' })).toBe(true);
  });
});

describe('generateWithFallback: partial output', () => {
  it('returns the result with `error` set when the stream breaks after some text, without trying other models', async () => {
    reply(A, { partial: textEvent('L1: あ\n'), throws: new LLMError('network', 'ネットワークに接続できませんでした。') });
    reply(B, ok('should not be used'));
    const run = start([gemini()]);
    const result = await run.promise;

    expect(run.chunks).toEqual(['L1: あ\n']);
    expect(result.error).toBeInstanceOf(LLMError);
    expect(result.error?.kind).toBe('network');
    expect(result.error?.model).toBe(A);
    expect(result.model).toBe(A);
    expect(result.finish).toBe('unknown');
    expect(result.finishDetail).toBe('network');
    expect(generated).toEqual([A]); // no reconnect, no fallback: the caller keeps what arrived
    expect(await readCooldowns()).toEqual({});
  });

  it('does the same for an error event that arrives inside a 200 stream after text', async () => {
    reply(A, {
      status: 200,
      body: textEvent('L1: あ\n') + ev({ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } }),
    });
    const run = start([gemini()]);
    const result = await run.promise;
    expect(run.chunks).toEqual(['L1: あ\n']);
    expect(result.error?.kind).toBe('overloaded');
    expect(generated).toEqual([A]);
  });

  it('keeps the partial output when onText said the text was useful', async () => {
    reply(A, { partial: textEvent('{"t":"line"}\n'), throws: new LLMError('overloaded', 'busy') });
    reply(B, ok('should not be used'));
    const run = start([gemini()], undefined, () => true);
    const result = await run.promise;
    expect(result.error?.kind).toBe('overloaded');
    expect(result.model).toBe(A);
    expect(generated).toEqual([A]);
  });

  it('falls through to the next model when onText said false for everything before the error', async () => {
    reply(A, { partial: textEvent('{"t":"song"}\n') + textEvent('{"t":"song"}\n'), throws: new LLMError('overloaded', 'busy') });
    reply(B, ok('L1: あ\n'));
    const run = start([gemini()], undefined, () => false);
    const result = await run.promise;
    expect(generated).toEqual([A, B]);
    expect(result.model).toBe(B);
    expect(result.error).toBeUndefined();
    expect(result.finish).toBe('stop');
    expect((await readCooldowns())[cooldownKey(A)]?.reason).toBe('overloaded'); // the failed model is still benched
    // the abandoned attempt's text was delivered, then the next model's text follows it
    expect(run.chunks).toEqual(['{"t":"song"}\n', '{"t":"song"}\n', 'L1: あ\n']);
  });

  it('keeps the attempt once any chunk was useful, even if earlier ones were not', async () => {
    reply(A, { partial: textEvent('first\n') + textEvent('second\n') + textEvent('third\n'), throws: new LLMError('overloaded', 'busy') });
    reply(B, ok('should not be used'));
    const run = start([gemini()], undefined, (chunks) => chunks.length >= 2);
    const result = await run.promise;
    expect(result.error?.kind).toBe('overloaded');
    expect(generated).toEqual([A]);
  });

  it('a "not yet useful" attempt that ends cleanly is still a success', async () => {
    reply(A, ok('L1: あ\n'));
    const result = await start([gemini()], undefined, () => false).promise;
    expect(result.model).toBe(A);
    expect(result.error).toBeUndefined();
  });

  it('gives up with the error when the models keep failing before anything useful', async () => {
    for (const model of [A, B]) reply(model, { partial: textEvent('x\n'), throws: new LLMError('blocked', 'filtered') });
    const { error } = await settle(start([gemini()], undefined, () => false));
    expect(error?.kind).toBe('blocked');
    expect(generated).toEqual([A, B]); // a second refusal ends the round
  });

  it('a stream error before any text still falls through to the next model', async () => {
    reply(A, { status: 200, body: ev({ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } }) });
    reply(B, ok('L1: い\n'));
    const result = await start([gemini()]).promise;
    expect(generated).toEqual([A, B]);
    expect(result.error).toBeUndefined();
  });
});

describe('generateWithFallback: waiting and retrying (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('waits and goes around again when every model is busy, then gives up with "overloaded"', async () => {
    reply(A, busy(), busy(), busy());
    reply(B, busy(), busy(), busy());
    reply(C, busy(), busy(), busy());
    const run = start([gemini()]);
    const done = settle(run);
    await vi.advanceTimersByTimeAsync(40_000);
    const { error } = await done;

    expect(error?.kind).toBe('overloaded');
    expect(generated).toEqual([A, B, C, A, B, A, B]); // retry passes only revisit the best two busy models
    expect(run.statuses.filter((s) => s.includes('どのモデルも混雑しています'))).toHaveLength(10 + 25);
    expect(run.statuses).toContain('どのモデルも混雑しています · 10秒後にもう一度試します');
    expect(run.statuses).toContain('どのモデルも混雑しています · 25秒後にもう一度試します');
  });

  it('succeeds on a retry pass when a busy model recovers', async () => {
    reply(A, busy(), ok('L1: あ\n'));
    reply(B, busy());
    reply(C, busy());
    const run = start([gemini()]);
    const done = settle(run);
    await vi.advanceTimersByTimeAsync(11_000);
    const { result, error } = await done;
    expect(error).toBeUndefined();
    expect(result?.model).toBe(A);
    expect(generated).toEqual([A, B, C, A]);
  });

  it('does not run extra passes when a failure is not "busy" (e.g. bad request)', async () => {
    reply(A, googleError(400, 'INVALID_ARGUMENT', 'bad field'));
    reply(B, googleError(400, 'INVALID_ARGUMENT', 'bad field'));
    reply(C, googleError(400, 'INVALID_ARGUMENT', 'bad field'));
    const done = settle(start([gemini()]));
    await vi.advanceTimersByTimeAsync(1_000);
    const { error } = await done;
    expect(error?.kind).toBe('bad-request');
    expect(generated).toEqual([A, B, C]);
  });

  it('stops waiting when aborted', async () => {
    reply(A, busy(), busy());
    reply(B, busy(), busy());
    reply(C, busy(), busy());
    const controller = new AbortController();
    const done = settle(start([gemini()], controller.signal));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(generated).toHaveLength(3);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const { error } = await done;
    expect(error?.kind).toBe('aborted');
    expect(generated).toHaveLength(3);
  });

  it('reconnects once after a network error that produced no text', async () => {
    reply(A, { throws: new LLMError('network', 'down') }, ok('L1: あ\n'));
    const run = start([gemini()]);
    const done = settle(run);
    await vi.advanceTimersByTimeAsync(2_500);
    const { result } = await done;
    expect(result?.model).toBe(A);
    expect(generated).toEqual([A, A]);
    expect(run.statuses.some((s) => s.includes('再接続'))).toBe(true);
  });

  it('retries a short per-minute limit after the advertised delay', async () => {
    reply(A, rateLimited('2s'), ok('L1: あ\n'));
    const run = start([gemini()]);
    const done = settle(run);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(generated).toEqual([A]); // still waiting
    await vi.advanceTimersByTimeAsync(3_000);
    const { result } = await done;
    expect(result?.model).toBe(A);
    expect(generated).toEqual([A, A]);
    expect(run.statuses).toContain('3.5-flash の回数制限 · 3秒後に再試行');
  });
});

describe('nextPacificMidnight', () => {
  it('lands one minute after the next midnight in Los Angeles (winter, PST = UTC-8)', () => {
    expect(nextPacificMidnight(Date.UTC(2026, 0, 15, 20, 0, 0))).toBe(Date.UTC(2026, 0, 16, 8, 1, 0));
  });

  it('handles daylight saving time (summer, PDT = UTC-7)', () => {
    expect(nextPacificMidnight(Date.UTC(2026, 6, 15, 20, 0, 0))).toBe(Date.UTC(2026, 6, 16, 7, 1, 0));
  });

  it('treats exactly-midnight as the start of a full day (the formatter may print hour 24)', () => {
    const midnight = Date.UTC(2026, 0, 15, 8, 0, 0); // 00:00 PST
    expect(nextPacificMidnight(midnight)).toBe(midnight + 24 * 3600_000 + 60_000);
  });
});
