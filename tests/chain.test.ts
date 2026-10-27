import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  availability as availabilityOf,
  cleanOtherProviders,
  clearCooldowns,
  cooldownId as cooldownIdOf,
  generateWithFallback,
  keyStatus as keyStatusOf,
  keyTag as keyTagOf,
  markKey as markKeyOf,
  nextPacificMidnight,
  orderByHealth,
  selectCandidates,
  type ChainResult,
  type ModelHealth,
} from '../src/llm/chain';
import { LLMError } from '../src/llm/errors';
import { FIRST_TEXT_TIMEOUT_MS } from '../src/llm/gemini';
import type { HttpResult, StreamRequest } from '../src/platform/http';
import { streamRequest } from '../src/platform/http';
import { getJSON, listKeys, memoryStorage, setJSON, setKV } from '../src/platform/storage';

vi.mock('../src/platform/http', () => ({ streamRequest: vi.fn() }));

const http = vi.mocked(streamRequest);

/* ---------- scripted Gemini endpoints ---------- */

const A = 'gemini-3.5-flash'; // rank 1035
const B = 'gemini-2.5-flash'; // rank 1025
const C = 'gemini-3.5-flash-lite'; // rank 135
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

const MODEL_LIST = {
  models: [A, B, C].map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })),
};

/** `hangMs` makes the endpoint stay silent that long first (fake timers must be on): a model that
 *  is slow to its first text, or never answers and is cut off by the transport's watchdog. */
type Reply =
  | { status: number; body: string; hangMs?: number }
  | { throws: LLMError; partial?: string; hangMs?: number };

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
  if (req.url.includes('/v1beta/models?') || false) {
    next = listReply;
    model = '(list)';
  } else {
    const gemini = /models\/([^:]+):streamGenerateContent/.exec(req.url);
    if (gemini) model = decodeURIComponent(gemini[1]!);
    else throw new Error(`unexpected URL ${req.url}`);
    generated.push(model);
    generatedKeys.push(req.headers?.['x-goog-api-key'] ?? '');
    next = queues.get(model)?.shift();
  }
  if (!next) throw new Error(`no scripted reply left for ${model}`);
  if (next.hangMs) await new Promise((resolve) => setTimeout(resolve, next.hangMs));
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

/** A run's inputs: the key, and optionally the one model pinned (scripts only: ChainOptions.onlyModels). */
interface Cfg { apiKey: string; model?: string }
const gemini = (overrides: Partial<Cfg> = {}): Cfg => ({ apiKey: 'test-key', ...overrides });
const availability = (cfg: Cfg) => availabilityOf(cfg.apiKey);
const cooldownId = (cfg: Cfg, model: string) => cooldownIdOf(cfg.apiKey, model);
const keyStatus = (cfg: Cfg) => keyStatusOf(cfg.apiKey);
const keyTag = (cfg: Cfg) => keyTagOf(cfg.apiKey);
const markKey = (cfg: Cfg, bad: boolean) => markKeyOf(cfg.apiKey, bad);
/** Cooldowns are kept per API key and model. */
const cooldownKey = (model: string, cfg: Cfg = gemini()) => cooldownId(cfg, model);

type StoredCooldowns = Record<string, { until: number; reason: string }>;
const seedCooldowns = (entries: StoredCooldowns) => setJSON(COOLDOWNS, entries);
/** Pre-seeds the model list a provider would otherwise fetch, so no request is made for it. */
const seedModels = (cfg: Cfg, ...ids: string[]) =>
  setJSON(`ll3:models:${cooldownId(cfg, '')}`, { at: Date.now(), models: ids.map((m, i) => ({ id: m, label: m, rank: 100 - i })) });

interface Run {
  chunks: string[];
  statuses: string[];
  promise: Promise<ChainResult>;
}

/** `verdict` is what the consumer's onText answers for a chunk (chunks so far, including this one);
 *  by default it gives no verdict, like a consumer written before verdicts existed. */
function start(cfg: Cfg, signal?: AbortSignal, verdict?: (chunks: string[]) => boolean | void): Run {
  const chunks: string[] = [];
  const statuses: string[] = [];
  const promise = generateWithFallback(
    cfg.apiKey,
    {
      system: 'sys', user: 'usr', maxOutputTokens: 1000,
      onText: (t) => { chunks.push(t); return verdict?.(chunks); },
    },
    { onStatus: (s) => statuses.push(s), signal, ...(cfg.model ? { onlyModels: [cfg.model] } : {}) },
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
    const run = start(gemini());
    const result = await run.promise;

    expect(generated).toEqual([A, B]);
    expect(result.model).toBe(B);
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
    const run = start(gemini());
    await run.promise;
    expect(run.chunks).toEqual(['L1: あ\n']);
  });

  it('remembers a busy model for two minutes and tries it last next time', async () => {
    reply(A, busy());
    reply(B, ok('L1: あ\n'));
    await start(gemini()).promise;
    const cooldowns = await readCooldowns();
    expect(cooldowns[cooldownKey(A)]?.reason).toBe('overloaded');
    expect(cooldowns[cooldownKey(A)]!.until - Date.now()).toBeGreaterThan(60_000);
    expect(cooldowns[cooldownKey(A)]!.until - Date.now()).toBeLessThanOrEqual(120_000);
    expect(cooldowns[cooldownKey(B)]).toBeUndefined();

    generated = [];
    reply(B, busy());
    reply(C, ok('L1: い\n'));
    const second = await start(gemini()).promise;
    expect(generated).toEqual([B, C]); // A was demoted to the end and never needed
    expect(second.model).toBe(C);
  });

  it('uses the pinned model only, without listing models', async () => {
    reply(C, ok('L1: う\n'));
    const result = await start(gemini({ model: C })).promise;
    expect(result.model).toBe(C);
    expect(generated).toEqual([C]);
    expect(http.mock.calls.some(([r]) => r.url.includes('/v1beta/models?'))).toBe(false);
  });

  it('falls back to a built-in model list when listing fails for a non-auth reason', async () => {
    listReply = { status: 500, body: 'internal error' };
    reply('gemini-3.8-flash', ok('L1: え\n'));
    const result = await start(gemini()).promise;
    expect(result.model).toBe('gemini-3.8-flash');
  });

  it('reports an auth error from the model list without trying any model', async () => {
    listReply = unauthorized();
    const { error } = await settle(start(gemini()));
    expect(error?.kind).toBe('auth');
    expect(generated).toEqual([]);
  });

  it('returns finish "length" for MAX_TOKENS so the caller can report the cut', async () => {
    reply(A, { status: 200, body: textEvent('L1: あ\n') + stopEvent('MAX_TOKENS') });
    const result = await start(gemini()).promise;
    expect(result.finish).toBe('length');
    expect(result.text).toBe('L1: あ\n');
  });

  it('never forwards thought parts to onText', async () => {
    reply(A, {
      status: 200,
      body: textEvent('Let me think about slang…', { thought: true }) + textEvent('L1: ') + textEvent('あ\n') + textEvent('more thinking', { thought: true }) + stopEvent(),
    });
    const run = start(gemini());
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
    const first = start(gemini());
    await first.promise;
    expect(generated).toEqual([A, B]);
    expect(first.statuses.some((s) => s.includes('今日の上限'))).toBe(true);

    const cooldown = (await readCooldowns())[cooldownKey(A)]!;
    expect(cooldown.reason).toBe('quota');
    expect(cooldown.until - Date.now()).toBeGreaterThan(0);
    expect(cooldown.until - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 120_000);

    generated = [];
    reply(B, ok('L1: い\n'));
    const second = await start(gemini()).promise;
    expect(generated).toEqual([B]); // A is not requested at all
    expect(second.model).toBe(B);
  });

  it('throws a quota error, and then a "all at the limit" error without any request', async () => {
    reply(A, dailyQuota());
    reply(B, dailyQuota());
    reply(C, dailyQuota());
    const first = await settle(start(gemini()));
    expect(first.error?.kind).toBe('quota');
    expect(generated).toEqual([A, B, C]);

    generated = [];
    const second = await settle(start(gemini()));
    expect(second.error?.kind).toBe('quota');
    expect(second.error?.status).toBe(429);
    expect(second.error?.message).toContain('上限');
    expect(generated).toEqual([]);
  });

  it('does not skip a model the user pinned, even when a cooldown is stored', async () => {
    reply(A, dailyQuota());
    const first = await settle(start(gemini({ model: A })));
    expect(first.error?.kind).toBe('quota');

    reply(A, ok('L1: あ\n'));
    const second = await start(gemini({ model: A })).promise;
    expect(second.model).toBe(A);
    expect(generated).toEqual([A, A]);
  });

  it('clearCooldowns() makes skipped models eligible again', async () => {
    reply(A, dailyQuota());
    reply(B, ok('L1: あ\n'));
    await start(gemini()).promise;
    await clearCooldowns();
    generated = [];
    reply(B, googleError(400, 'INVALID_ARGUMENT', 'bad field')); // B answered last time, so it is still asked first
    reply(A, ok('L1: い\n'));
    const result = await start(gemini()).promise;
    expect(generated).toEqual([B, A]); // A is no longer skipped
    expect(result.model).toBe(A);
  });

  it('parks a per-minute limit with a long retry delay for at least that long, without waiting', async () => {
    reply(A, rateLimited('120s'));
    reply(B, ok('L1: あ\n'));
    const run = start(gemini());
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
    await start(gemini()).promise;
    const cooldown = (await readCooldowns())[cooldownKey(A)]!;
    expect(cooldown.reason).toBe('not-found');
    expect(cooldown.until - Date.now()).toBeGreaterThan(2 * 24 * 3600_000);
  });
});

describe('generateWithFallback: when every candidate is cooling down', () => {
  const FREE = ['vendor/one:free', 'vendor/two:free', 'vendor/three:free'];

  it('reports a per-minute wait as "rate", not as the daily quota, without any request', async () => {
    const config = gemini();
    await seedModels(config, ...FREE);
    const until = Date.now() + 60_000;
    await seedCooldowns(Object.fromEntries(FREE.map((m) => [cooldownId(config, m), { until, reason: 'rate' }])));

    const { error } = await settle(start(config));
    expect(error).toBeInstanceOf(LLMError);
    expect(error?.kind).toBe('rate');
    expect(error?.retryAfterMs).toBeGreaterThan(0);
    expect(error?.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(error?.status).toBe(429);
    expect(http).not.toHaveBeenCalled();
  });

  it('reports the real reset: the earliest quota cooldown among the models', async () => {
    const g = gemini();
    await seedModels(g, A, B, C);
    const now = Date.now();
    await seedCooldowns({
      [cooldownId(g, A)]: { until: now + 10 * 3600_000, reason: 'quota' },
      [cooldownId(g, B)]: { until: now + 10 * 3600_000, reason: 'quota' },
      [cooldownId(g, C)]: { until: now + 3 * 3600_000, reason: 'quota' },
    });

    const { error } = await settle(start(g));
    expect(error?.kind).toBe('quota');
    expect(Math.abs(error!.retryAfterMs - 3 * 3600_000)).toBeLessThan(5_000); // C's, not the later ones
    expect(http).not.toHaveBeenCalled();
  });

  it('a quota wait is always reported above one minute, so it is read as a reset time', async () => {
    const g = gemini();
    await seedModels(g, A);
    await seedCooldowns({ [cooldownId(g, A)]: { until: Date.now() + 5_000, reason: 'quota' } });
    const { error } = await settle(start(g));
    expect(error?.kind).toBe('quota');
    expect(error?.retryAfterMs).toBeGreaterThan(60_000);
  });

  it('a short rate cooldown on one model beats a longer quota cooldown on another', async () => {
    const g = gemini();
    await seedModels(g, A, B, C);
    const now = Date.now();
    await seedCooldowns({
      [cooldownId(g, A)]: { until: now + 10 * 3600_000, reason: 'quota' },
      [cooldownId(g, B)]: { until: now + 10 * 3600_000, reason: 'quota' },
      [cooldownId(g, C)]: { until: now + 30_000, reason: 'rate' },
    });

    const { error } = await settle(start(g));
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
    const { error } = await settle(start(g));
    expect(error?.kind).toBe('quota'); // as before: nothing better to say
    expect(error?.retryAfterMs).toBe(0);
    expect(error?.message).toContain('上限');
    expect(http).not.toHaveBeenCalled();
  });

  it('a real quota error carries the reset time recorded in the cooldown table', async () => {
    reply(A, dailyQuota());
    reply(B, dailyQuota());
    reply(C, dailyQuota());
    const { error } = await settle(start(gemini()));
    expect(error?.kind).toBe('quota');
    expect(error?.model).toBe(A);
    const soonest = Math.min(...Object.values(await readCooldowns()).map((c) => c.until));
    expect(error!.retryAfterMs).toBeGreaterThan(60_000);
    expect(Math.abs(error!.retryAfterMs - (soonest - Date.now()))).toBeLessThan(5_000);
  });

  it('a real quota error turns into a short "rate" wait when another model returns within a minute', async () => {
    const g = gemini();
    await seedModels(g, A, B, C);
    await seedCooldowns({ [cooldownId(g, C)]: { until: Date.now() + 45_000, reason: 'rate' } });
    reply(A, dailyQuota());
    reply(B, dailyQuota());

    const { error } = await settle(start(g));
    expect(generated).toEqual([A, B]); // C is skipped, not tried
    expect(error?.kind).toBe('rate');
    expect(error?.retryAfterMs).toBeGreaterThan(30_000);
    expect(error?.retryAfterMs).toBeLessThanOrEqual(45_000);
  });

  it('passes an error that is not a quota error through unchanged', async () => {
    reply(B, googleError(400, 'INVALID_ARGUMENT', 'bad field'));
    const { error } = await settle(start(gemini({ model: B })));
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
    const first = await start(gemini()).promise;
    expect(generated).toEqual([B, C, A]); // the benched model goes last
    expect(first.model).toBe(A);
    expect(await readCooldowns()).toEqual({});

    generated = [];
    reply(A, ok('L1: い\n'));
    await start(gemini()).promise;
    expect(generated).toEqual([A]); // first in line again
  });

  it('keeps the other entries when one model recovers', async () => {
    await seedCooldowns({
      [cooldownKey(A)]: { until: Date.now() + 120_000, reason: 'overloaded' },
      [cooldownKey(C)]: { until: Date.now() + 3600_000, reason: 'quota' },
    });
    reply(B, googleError(400, 'INVALID_ARGUMENT', 'bad field'));
    reply(A, ok('L1: あ\n'));
    await start(gemini()).promise;
    expect(Object.keys(await readCooldowns())).toEqual([cooldownKey(C)]);
  });

  it('benches a model that broke after streaming text, so the next tap does not go back to it', async () => {
    reply(A, {
      status: 200,
      body: textEvent('L1: あ\n') + ev({ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } }),
    });
    const first = await start(gemini()).promise;
    expect(first.error?.kind).toBe('overloaded');
    expect(first.model).toBe(A);
    expect(generated).toEqual([A]);
    const cooldown = (await readCooldowns())[cooldownKey(A)];
    expect(cooldown?.reason).toBe('overloaded');
    expect(cooldown!.until - Date.now()).toBeGreaterThan(60_000);

    generated = [];
    reply(B, ok('L1: い\n'));
    const second = await start(gemini()).promise;
    expect(generated).toEqual([B]); // A was demoted to the end
    expect(second.model).toBe(B);
  });

  it('skips a model that hit a per-minute limit mid-stream until the limit has passed', async () => {
    reply(A, { partial: textEvent('L1: あ\n'), throws: new LLMError('rate', 'slow down', { status: 429, retryAfterMs: 5_000 }) });
    const first = await start(gemini()).promise;
    expect(first.error?.kind).toBe('rate');
    expect((await readCooldowns())[cooldownKey(A)]?.reason).toBe('rate');

    generated = [];
    reply(B, ok('L1: い\n'));
    await start(gemini()).promise;
    expect(generated).toEqual([B]);
  });

  it('does not bench a model whose stream merely dropped', async () => {
    reply(A, { partial: textEvent('L1: あ\n'), throws: new LLMError('network', 'down') });
    await start(gemini()).promise;
    expect(await readCooldowns()).toEqual({});
  });
});

describe('cooldown ids and API keys', () => {
  it('cooldownId is gemini, endpoint, key fingerprint and model', () => {
    const config = gemini();
    expect(cooldownId(config, 'm')).toBe(`gemini:${GEMINI_BASE}:${keyTag(config)}:m`);
    expect(cooldownId(config, '')).toBe(`gemini:${GEMINI_BASE}:${keyTag(config)}:`);
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
    await start(config).promise;
    const stored = await readCooldowns();
    expect(Object.keys(stored)).toEqual([cooldownId(config, A)]);
    expect(stored[cooldownKey(A, config)]?.reason).toBe('quota');
    expect(stored[cooldownKey(A, gemini({ apiKey: 'key-two' }))]).toBeUndefined();
  });

  it("still tries a second key after the first key's models are all in quota cooldown", async () => {
    const first = gemini({ apiKey: 'key-one' });
    const second = gemini({ apiKey: 'key-two' });
    reply(A, dailyQuota());
    reply(B, dailyQuota());
    reply(C, dailyQuota());
    expect((await settle(start(first))).error?.kind).toBe('quota');
    expect(generatedKeys).toEqual(['key-one', 'key-one', 'key-one']);

    // the first key is spent for today; the second is another project with its own quota
    generated = [];
    generatedKeys = [];
    reply(A, ok('L1: あ\n'));
    const run = start(second);
    const result = await run.promise;
    expect(result.model).toBe(A);
    expect(generated).toEqual([A]);
    expect(generatedKeys).toEqual(['key-two']); // nothing was spent on key-one
    expect(run.chunks.join('')).toBe('L1: あ\n');
    const stored = await readCooldowns();
    expect(Object.keys(stored).sort()).toEqual([A, B, C].map((m) => cooldownId(first, m)).sort());
  });

  it('keeps a spent key skipped, whichever way the same key is passed', async () => {
    const first = gemini({ apiKey: 'key-one' });
    reply(A, dailyQuota());
    reply(B, dailyQuota());
    reply(C, dailyQuota());
    await settle(start(first));

    generated = [];
    const again = await settle(start(gemini({ apiKey: '  key-one ' })));
    expect(again.error?.kind).toBe('quota');
    expect(again.error?.message).toContain('上限');
    expect(generated).toEqual([]);
  });

  it('keeps the model list per key too', async () => {
    const first = gemini({ apiKey: 'key-one' });
    const second = gemini({ apiKey: 'key-two' });
    reply(A, ok('L1: あ\n'), ok('L1: い\n'), ok('L1: う\n'));
    await start(first).promise;
    await start(second).promise;
    const listRequests = () => http.mock.calls.filter(([r]) => r.url.includes('/v1beta/models?'));
    expect(listRequests()).toHaveLength(2);
    expect(listRequests().map(([r]) => r.headers?.['x-goog-api-key'])).toEqual(['key-one', 'key-two']);
    expect((await getJSON<{ models: unknown[] } | null>(`ll3:models:${cooldownId(first, '')}`, null))?.models).toHaveLength(3);
    expect((await getJSON<{ models: unknown[] } | null>(`ll3:models:${cooldownId(second, '')}`, null))?.models).toHaveLength(3);

    // a key that is already listed is not listed again
    await start(first).promise;
    expect(listRequests()).toHaveLength(2);
  });
});

describe('generateWithFallback: auth', () => {
  it('throws kind "auth" on 401 and does not try the provider\'s other models', async () => {
    reply(A, unauthorized());
    reply(B, ok('L1: あ\n'));
    const { error } = await settle(start(gemini()));
    expect(error).toBeInstanceOf(LLMError);
    expect(error?.kind).toBe('auth');
    expect(error?.model).toBe(A);
    expect(generated).toEqual([A]);
    expect(await readCooldowns()).toEqual({}); // a bad key is not a cooldown
  });

  it('remembers a rejected key: keyStatus reports "bad" for that key only', async () => {
    const config = gemini();
    expect(await keyStatus(config)).toEqual({ kind: 'ok' });
    reply(A, unauthorized());
    await settle(start(config));

    expect(await keyStatus(config)).toEqual({ kind: 'bad' });
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
    await settle(start(config));
    expect((await keyStatus(config)).kind).not.toBe('bad');
  });

  it('keyStatus reports "resting" with the earliest reset when every model is out of quota', async () => {
    const config = gemini();
    reply(A, dailyQuota());
    reply(B, dailyQuota());
    reply(C, dailyQuota());
    await settle(start(config));
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
    const { error } = await settle(start(config));
    expect(error?.kind).toBe('auth');
    expect(await keyStatus(config)).toEqual({ kind: 'bad' });
  });

  it('throws an auth error without any request when there is no key', async () => {
    const { error } = await settle(start(gemini({ apiKey: '   ' })));
    expect(error?.kind).toBe('auth');
    expect(http).not.toHaveBeenCalled();
  });
});

describe('generateWithFallback: a 200 that produced no accepted line', () => {
  it('counts it as a failure, benches the model for 10 minutes and moves to the next one', async () => {
    reply(A, ok('this is not jsonl\n'));
    reply(B, ok('{"ok":1}\n'));
    const run = start(gemini(), undefined, (chunks) => chunks.join('').includes('{"ok"'));
    const result = await run.promise;

    expect(generated).toEqual([A, B]);
    expect(result.model).toBe(B);
    const cd = (await readCooldowns())[cooldownKey(A)];
    expect(cd?.reason).toBe('unusable');
    expect(cd!.until - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(cd!.until - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    const health = await getJSON<Record<string, { ok?: number; bad?: number }>>('ll3:health', {});
    expect(health[cooldownKey(A)]?.bad).toBeGreaterThan(0);
    expect(health[cooldownKey(A)]?.ok).toBeUndefined();
  });

  it('reports unusable when no model produced a line', async () => {
    reply(A, ok('junk'));
    reply(B, ok('junk'));
    reply(C, ok('junk'));
    const { error } = await settle(start(gemini(), undefined, () => false));
    expect(error?.kind).toBe('unusable');
  });
});

describe('selectCandidates', () => {
  const flash = Array.from({ length: 9 }, (_, i) => `gemini-3.${9 - i}-flash`);
  const lite = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'];
  const gemma = ['gemma-4-31b-it', 'gemma-3-27b-it'];

  it('keeps the first 6 Flash, 3 Flash-Lite and 1 Gemma, in the given order', () => {
    expect(selectCandidates([...flash, ...lite, ...gemma])).toEqual([...flash.slice(0, 6), ...lite.slice(0, 3), 'gemma-4-31b-it']);
  });

  it('passes shorter lists through untouched', () => {
    expect(selectCandidates([A, C])).toEqual([A, C]);
    expect(selectCandidates([])).toEqual([]);
  });
});

describe('generateWithFallback: tier slots', () => {
  it('starts on Flash-Lite when every Flash candidate is in a quota cooldown', async () => {
    const flash = Array.from({ length: 8 }, (_, i) => `gemini-3.${9 - i}-flash`);
    listReply = { status: 200, body: JSON.stringify({ models: [...flash, C].map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) }) };
    const until = Date.now() + 5 * 3600_000;
    await seedCooldowns(Object.fromEntries(flash.map((m) => [cooldownKey(m), { until, reason: 'quota' }])));
    reply(C, ok('L1: あ\n'));
    const result = await start(gemini()).promise;
    expect(generated).toEqual([C]);
    expect(result.model).toBe(C);
  });
});

describe('generateWithFallback: repeated silence', () => {
  const silent = (): Reply => ({ throws: new LLMError('timeout', '応答が途切れました。') });

  it('stops after two silent models in a row without trying the rest', async () => {
    reply(A, silent());
    reply(B, silent());
    reply(C, ok('should not be used'));
    const { error } = await settle(start(gemini()));
    expect(error?.kind).toBe('timeout');
    expect(generated).toEqual([A, B]);
  });

  it('does not count silences that another failure separates', async () => {
    reply(A, silent());
    reply(B, dailyQuota());
    reply(C, silent());
    const { error } = await settle(start(gemini()));
    expect(generated).toEqual([A, B, C]);
    expect(error).toBeDefined();
  });

  it('still succeeds when the second model answers after one silence', async () => {
    reply(A, silent());
    reply(B, ok('L1: あ\n'));
    const result = await start(gemini()).promise;
    expect(result.model).toBe(B);
  });
});

describe('generateWithFallback: partial output', () => {
  it('returns the result with `error` set when the stream breaks after some text, without trying other models', async () => {
    reply(A, { partial: textEvent('L1: あ\n'), throws: new LLMError('network', 'ネットワークに接続できませんでした。') });
    reply(B, ok('should not be used'));
    const run = start(gemini());
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
    const run = start(gemini());
    const result = await run.promise;
    expect(run.chunks).toEqual(['L1: あ\n']);
    expect(result.error?.kind).toBe('overloaded');
    expect(generated).toEqual([A]);
  });

  it('keeps the partial output when onText said the text was useful', async () => {
    reply(A, { partial: textEvent('{"t":"line"}\n'), throws: new LLMError('overloaded', 'busy') });
    reply(B, ok('should not be used'));
    const run = start(gemini(), undefined, () => true);
    const result = await run.promise;
    expect(result.error?.kind).toBe('overloaded');
    expect(result.model).toBe(A);
    expect(generated).toEqual([A]);
  });

  it('falls through to the next model when onText said false for everything before the error', async () => {
    reply(A, { partial: textEvent('{"t":"song"}\n') + textEvent('{"t":"song"}\n'), throws: new LLMError('overloaded', 'busy') });
    reply(B, ok('L1: あ\n'));
    const run = start(gemini(), undefined, (chunks) => chunks[chunks.length - 1]!.startsWith('L1'));
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
    const run = start(gemini(), undefined, (chunks) => chunks.length >= 2);
    const result = await run.promise;
    expect(result.error?.kind).toBe('overloaded');
    expect(generated).toEqual([A]);
  });

  it('gives up with the error when the models keep failing before anything useful', async () => {
    for (const model of [A, B]) reply(model, { partial: textEvent('x\n'), throws: new LLMError('blocked', 'filtered') });
    const { error } = await settle(start(gemini(), undefined, () => false));
    expect(error?.kind).toBe('blocked');
    expect(generated).toEqual([A, B]); // a second refusal ends the round
  });

  it('a stream error before any text still falls through to the next model', async () => {
    reply(A, { status: 200, body: ev({ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } }) });
    reply(B, ok('L1: い\n'));
    const result = await start(gemini()).promise;
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
    const run = start(gemini());
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
    const run = start(gemini());
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
    const done = settle(start(gemini()));
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
    const done = settle(start(gemini(), controller.signal));
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
    const run = start(gemini());
    const done = settle(run);
    await vi.advanceTimersByTimeAsync(2_500);
    const { result } = await done;
    expect(result?.model).toBe(A);
    expect(generated).toEqual([A, A]);
    expect(run.statuses.some((s) => s.includes('再接続'))).toBe(true);
  });

  it('retries a short per-minute limit after the advertised delay', async () => {
    reply(A, rateLimited('2s'), ok('L1: あ\n'));
    const run = start(gemini());
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

/* ---------- model health ---------- */

const HEALTH = 'll3:health';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
type StoredHealth = Record<string, ModelHealth>;
const readHealth = () => getJSON<StoredHealth>(HEALTH, {});
const seedHealth = (entries: StoredHealth) => setJSON(HEALTH, entries);
/** The endpoint stays silent for `ms` before it answers (fake timers must be on). */
const slowly = (ms: number, scripted: Reply): Reply => ({ ...scripted, hangMs: ms });
const badField = () => googleError(400, 'INVALID_ARGUMENT', 'bad field');

describe('orderByHealth', () => {
  const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);
  const FLASH_1 = 'gemini-3.5-flash'; // rank 1035
  const FLASH_2 = 'gemini-3-flash-preview'; // rank 1027
  const FLASH_3 = 'gemini-2.5-flash'; // rank 1025
  const LITE_1 = 'gemini-3.5-flash-lite'; // rank 135
  const LITE_2 = 'gemini-2.5-flash-lite'; // rank 125
  const GEMMA = 'gemma-3-27b-it'; // rank 1.03
  const ranked = [FLASH_1, FLASH_2, FLASH_3, LITE_1, LITE_2, GEMMA];
  const order = (stats: Record<string, ModelHealth>, ids = ranked) => orderByHealth(ids, stats, NOW);
  const answered = (ms: number, ago = MIN): ModelHealth => ({ ok: NOW - ago, ms });

  it('keeps the given order when nothing is known, and leaves its input alone', () => {
    const ids = [...ranked];
    expect(orderByHealth(ids, {}, NOW)).toEqual(ranked);
    expect(ids).toEqual(ranked);
  });

  it('puts models that answered recently first, fastest first', () => {
    expect(order({ [FLASH_1]: answered(4_000), [FLASH_2]: answered(900), [FLASH_3]: answered(2_000) }))
      .toEqual([FLASH_2, FLASH_3, FLASH_1, LITE_1, LITE_2, GEMMA]);
  });

  it('puts a model that answered ahead of models nothing is known about', () => {
    expect(order({ [FLASH_3]: answered(5_000) })).toEqual([FLASH_3, FLASH_1, FLASH_2, LITE_1, LITE_2, GEMMA]);
  });

  it('keeps the rank order between models that are equally fast, and puts one without a time after those with one', () => {
    expect(order({ [FLASH_2]: answered(1_000), [FLASH_3]: answered(1_000) })).toEqual([FLASH_2, FLASH_3, FLASH_1, LITE_1, LITE_2, GEMMA]);
    expect(order({ [FLASH_1]: { ok: NOW - MIN }, [FLASH_3]: answered(900) })).toEqual([FLASH_3, FLASH_1, FLASH_2, LITE_1, LITE_2, GEMMA]);
  });

  it('puts a model that was overloaded or silent in the last half hour last in its tier', () => {
    expect(order({ [FLASH_1]: { bad: NOW - 5 * MIN } })).toEqual([FLASH_2, FLASH_3, FLASH_1, LITE_1, LITE_2, GEMMA]);
    expect(order({ [FLASH_1]: { bad: NOW - 5 * MIN }, [FLASH_2]: { bad: NOW - MIN } })).toEqual([FLASH_3, FLASH_1, FLASH_2, LITE_1, LITE_2, GEMMA]);
  });

  it('forgives a failure after half an hour', () => {
    expect(order({ [FLASH_1]: { bad: NOW - 29 * MIN } }).indexOf(FLASH_1)).toBe(2);
    expect(order({ [FLASH_1]: { bad: NOW - 31 * MIN } })).toEqual(ranked);
    expect(order({ [FLASH_1]: { bad: NOW - 30 * MIN } })).toEqual(ranked);
  });

  it('weighs a failure against the last answer: whichever is newer decides', () => {
    // answered 20 minutes ago, failed 10 minutes ago: last
    expect(order({ [FLASH_1]: { ok: NOW - 20 * MIN, ms: 800, bad: NOW - 10 * MIN } })).toEqual([FLASH_2, FLASH_3, FLASH_1, LITE_1, LITE_2, GEMMA]);
    // failed 20 minutes ago, answered 10 minutes ago: proven again, first
    expect(order({ [FLASH_3]: { ok: NOW - 10 * MIN, ms: 800, bad: NOW - 20 * MIN } })).toEqual([FLASH_3, FLASH_1, FLASH_2, LITE_1, LITE_2, GEMMA]);
    // failed days ago, answered since: proven
    expect(order({ [FLASH_3]: { ok: NOW - 2 * DAY, ms: 800, bad: NOW - 3 * DAY } })[0]).toBe(FLASH_3);
  });

  it('puts a model back among the unknown ones when its failure was not recent but is newer than its answer', () => {
    expect(order({ [FLASH_3]: { ok: NOW - 2 * DAY, ms: 500, bad: NOW - 40 * MIN }, [FLASH_2]: answered(3_000) }))
      .toEqual([FLASH_2, FLASH_1, FLASH_3, LITE_1, LITE_2, GEMMA]);
  });

  it('does not trust an answer older than a week', () => {
    expect(order({ [FLASH_3]: answered(100, 8 * DAY) })).toEqual(ranked);
    expect(order({ [FLASH_3]: answered(100, 6 * DAY) })[0]).toBe(FLASH_3);
    // a recent failure still counts against a model whose last answer is old
    expect(order({ [FLASH_1]: { ok: NOW - 9 * DAY, ms: 100, bad: NOW - MIN } })).toEqual([FLASH_2, FLASH_3, FLASH_1, LITE_1, LITE_2, GEMMA]);
  });

  it('keeps Flash ahead of Flash-Lite and Gemma however fast the others are', () => {
    expect(order({ [FLASH_1]: answered(30_000), [LITE_2]: answered(20), [LITE_1]: answered(50), [GEMMA]: answered(10) }))
      .toEqual([FLASH_1, FLASH_2, FLASH_3, LITE_2, LITE_1, GEMMA]);
    // even when every Flash model failed a minute ago and a Lite model is proven
    expect(order({ [FLASH_1]: { bad: NOW - MIN }, [FLASH_2]: { bad: NOW - MIN }, [FLASH_3]: { bad: NOW - MIN }, [LITE_2]: answered(10) }))
      .toEqual([FLASH_1, FLASH_2, FLASH_3, LITE_2, LITE_1, GEMMA]);
  });

  it('orders inside the Flash-Lite and Gemma tiers the same way', () => {
    expect(order({ [LITE_1]: { bad: NOW - MIN } })).toEqual([FLASH_1, FLASH_2, FLASH_3, LITE_2, LITE_1, GEMMA]);
    expect(order({ [LITE_2]: answered(700) })).toEqual([FLASH_1, FLASH_2, FLASH_3, LITE_2, LITE_1, GEMMA]);
    expect(order({ [GEMMA]: { bad: NOW - MIN } })).toEqual(ranked); // already last, still last
    expect(order({ [GEMMA]: answered(10) })).toEqual(ranked); // never ahead of Lite
  });

  it('sorts a list that is not in rank order into its tiers (the built-in fallback list)', () => {
    expect(order({}, [FLASH_1, LITE_1, FLASH_3, GEMMA, FLASH_2])).toEqual([FLASH_1, FLASH_3, FLASH_2, LITE_1, GEMMA]);
  });
});

describe('generateWithFallback: model health (fake timers)', () => {
  const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  /** One call, with the fake clock advanced by `ms` (enough for every scripted silence). */
  async function call(ms = 0, cfg: Cfg = gemini()) {
    const run = start(cfg);
    const done = settle(run);
    await vi.advanceTimersByTimeAsync(ms);
    return { run, ...(await done) };
  }

  describe('what is recorded', () => {
    it('keeps the time of the last answer and how long its first text took', async () => {
      reply(A, slowly(3_000, ok('L1: あ\n')));
      const { result } = await call(3_000);
      expect(result?.model).toBe(A);
      expect((await readHealth())[cooldownKey(A)]).toEqual({ ok: NOW + 3_000, ms: 3_000 });
    });

    it('times the first text, not the end of the answer', async () => {
      http.mockImplementation(async (req) => {
        if (req.url.includes('/v1beta/models?')) return { status: 200, text: JSON.stringify(MODEL_LIST), headers: '' };
        generated.push(decodeURIComponent(/models\/([^:]+):/.exec(req.url)![1]!));
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const first = textEvent('L1: あ\n');
        req.onText?.(first);
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        const rest = stopEvent();
        req.onText?.(rest);
        return { status: 200, text: first + rest, headers: '' };
      });
      await call(10_000);
      expect(generated).toEqual([A]);
      expect((await readHealth())[cooldownKey(A)]).toEqual({ ok: NOW + 10_000, ms: 2_000 });
    });

    it('averages the times of successive answers, the newest counting half', async () => {
      for (const ms of [3_000, 1_000, 500]) {
        reply(A, slowly(ms, ok('L1: あ\n')));
        await call(ms);
      }
      expect((await readHealth())[cooldownKey(A)]?.ms).toBe(1_250); // 3000, then 2000, then 1250
    });

    it('notes an overloaded model as bad, and the model that answered instead as good', async () => {
      reply(A, busy());
      reply(B, ok('L1: あ\n'));
      await call();
      const health = await readHealth();
      expect(health[cooldownKey(A)]).toEqual({ bad: NOW });
      expect(health[cooldownKey(B)]).toEqual({ ok: NOW, ms: 0 });
    });

    it('notes a model that broke after streaming text as bad, not as an answer', async () => {
      reply(A, { partial: textEvent('L1: あ\n'), throws: new LLMError('overloaded', 'busy') });
      const { result } = await call();
      expect(result?.error?.kind).toBe('overloaded');
      expect((await readHealth())[cooldownKey(A)]).toEqual({ bad: NOW });
    });

    it('keeps the earlier answer when a model later fails, so the failure can be weighed against it', async () => {
      reply(A, ok('L1: あ\n'));
      await call();
      await vi.advanceTimersByTimeAsync(MIN);
      reply(A, busy());
      reply(B, ok('L1: い\n'));
      await call();
      expect((await readHealth())[cooldownKey(A)]).toEqual({ ok: NOW, ms: 0, bad: NOW + MIN });
    });

    it('notes nothing for failures that say nothing about speed or load', async () => {
      reply(A, dailyQuota());
      reply(B, badField());
      reply(C, rateLimited('120s'));
      await call();
      expect(generated).toEqual([A, B, C]);
      expect(await readHealth()).toEqual({});
    });

    it('does not note a network drop, even after text', async () => {
      reply(A, { partial: textEvent('L1: あ\n'), throws: new LLMError('network', 'down') });
      await call();
      expect(await readHealth()).toEqual({});
    });
  });

  describe('a model that never answers', () => {
    const silent = () => new LLMError('timeout', '応答が途切れました。');

    it('is given up on after its first-text timeout, benched for five minutes, and skipped by the next call', async () => {
      reply(A, { throws: silent(), hangMs: FIRST_TEXT_TIMEOUT_MS });
      reply(B, ok('L1: あ\n'));
      const first = start(gemini());
      const done = settle(first);
      await vi.advanceTimersByTimeAsync(FIRST_TEXT_TIMEOUT_MS - 1);
      expect(generated).toEqual([A]); // still waiting for A's first text
      await vi.advanceTimersByTimeAsync(1);
      const { result } = await done;
      expect(result?.model).toBe(B);
      expect(generated).toEqual([A, B]);
      expect(first.statuses).toContain('3.5-flash が応答なし · 次へ');

      const failedAt = NOW + FIRST_TEXT_TIMEOUT_MS;
      expect((await readCooldowns())[cooldownKey(A)]).toEqual({ until: failedAt + 5 * MIN, reason: 'timeout' });
      expect((await readHealth())[cooldownKey(A)]).toEqual({ bad: failedAt });

      // the next call goes straight to B and never asks A
      generated = [];
      reply(B, ok('L1: い\n'));
      expect((await call()).result?.model).toBe(B);
      expect(generated).toEqual([B]);

      // five minutes later A may be asked again, but behind B, which has been answering
      await vi.advanceTimersByTimeAsync(5 * MIN);
      generated = [];
      reply(B, badField());
      reply(A, ok('L1: う\n'));
      const third = await call();
      expect(generated).toEqual([B, A]);
      expect(third.result?.model).toBe(A);
    });

    it('does not ask a benched model while its five minutes last, however the others fare', async () => {
      reply(A, { throws: silent(), hangMs: 30_000 });
      reply(B, badField());
      reply(C, badField());
      await call(30_000);
      expect(generated).toEqual([A, B, C]);

      generated = [];
      await vi.advanceTimersByTimeAsync(5 * MIN - 1);
      reply(B, badField());
      reply(C, badField());
      const { error } = await call();
      expect(generated).toEqual([B, C]); // A stays out until the last millisecond of its bench
      expect(error?.kind).toBe('bad-request');
    });

    it('is benched too when it goes silent after it had started to answer', async () => {
      reply(A, { partial: textEvent('L1: あ\n'), throws: silent() });
      const { result } = await call();
      expect(result?.error?.kind).toBe('timeout');
      expect(result?.model).toBe(A);
      expect(generated).toEqual([A]);
      expect((await readCooldowns())[cooldownKey(A)]).toEqual({ until: NOW + 5 * MIN, reason: 'timeout' });
      expect((await readHealth())[cooldownKey(A)]).toEqual({ bad: NOW });

      generated = [];
      reply(B, ok('L1: い\n'));
      await call();
      expect(generated).toEqual([B]);
    });

    it('is un-benched when it answers a pinned request', async () => {
      const pinned = gemini({ model: A });
      reply(A, { throws: silent(), hangMs: 30_000 });
      expect((await call(30_000, pinned)).error?.kind).toBe('timeout');
      expect((await readCooldowns())[cooldownKey(A, pinned)]?.reason).toBe('timeout');

      reply(A, ok('L1: あ\n')); // a pinned model is asked despite the bench
      expect((await call(0, pinned)).result?.model).toBe(A);
      expect(await readCooldowns()).toEqual({});
    });

    it('is reported as a short "rate" wait, not as the daily quota, once every model has been benched', async () => {
      for (const model of [A, B, C]) reply(model, { throws: silent(), hangMs: 30_000 });
      const first = await call(90_000);
      expect(first.error?.kind).toBe('timeout');
      expect(generated).toEqual([A, B]); // two silent models in a row end the call
      const third = await call(90_000);
      expect(third.error?.kind).toBe('timeout');
      expect(generated).toEqual([A, B, C]); // the next call reaches the one that was left

      generated = [];
      const aUntil = (await readCooldowns())[cooldownKey(A)]!.until;
      const second = await call();
      expect(generated).toEqual([]); // nothing is asked
      expect(second.error?.kind).toBe('rate');
      expect(second.error?.status).toBe(429);
      expect(second.error?.retryAfterMs).toBe(aUntil - Date.now()); // A is the first to come back
      // the head's "worth a tap" check agrees: this is a short wait, not "out for the day"
      expect(await availability(gemini())).toEqual({ ok: true, until: 0 });
      expect(await keyStatus(gemini())).toEqual({ kind: 'ok' });
    });

    it('turns a quota error into the short wait of a benched model that is back sooner', async () => {
      await seedCooldowns({ [cooldownKey(A)]: { until: NOW + 4 * MIN, reason: 'timeout' } });
      reply(B, dailyQuota());
      reply(C, dailyQuota());
      const { error } = await call();
      expect(generated).toEqual([B, C]);
      expect(error?.kind).toBe('rate');
      expect(error?.retryAfterMs).toBe(4 * MIN);
    });

    it('is still reported as a timeout when the other models were out of quota', async () => {
      reply(A, { throws: silent(), hangMs: 30_000 });
      reply(B, dailyQuota());
      reply(C, dailyQuota());
      const { error } = await call(30_000);
      expect(error?.kind).toBe('timeout');
      expect(error?.model).toBe(A);
    });
  });

  describe('the order of automatically chosen Gemini models', () => {
    it('tries the faster of two proven models first, and proven models before unknown ones', async () => {
      await seedHealth({
        [cooldownKey(A)]: { ok: NOW - MIN, ms: 4_000 },
        [cooldownKey(B)]: { ok: NOW - MIN, ms: 1_500 },
      });
      for (const model of [A, B, C]) reply(model, badField());
      await call();
      expect(generated).toEqual([B, A, C]);
    });

    it('puts a model that failed within half an hour behind the unknown ones, and tries it again later', async () => {
      await seedHealth({ [cooldownKey(A)]: { bad: NOW - 10 * MIN } });
      for (const model of [A, B, C]) reply(model, badField());
      await call();
      expect(generated).toEqual([B, A, C]);

      generated = [];
      await vi.advanceTimersByTimeAsync(21 * MIN); // 31 minutes since the failure
      for (const model of [A, B, C]) reply(model, badField());
      await call();
      expect(generated).toEqual([A, B, C]);
    });

    it('learns which model is quick from its own answers', async () => {
      reply(A, slowly(5_000, ok('L1: あ\n')));
      await call(5_000); // A answers, slowly
      reply(A, badField());
      reply(B, slowly(1_000, ok('L1: い\n')));
      await call(1_000); // A (proven) is asked first and refuses; B answers quickly
      expect(generated).toEqual([A, A, B]);

      generated = [];
      reply(B, ok('L1: う\n'));
      await call();
      expect(generated).toEqual([B]); // B has been quicker
    });

    it('keeps Flash ahead of Flash-Lite however fast Flash-Lite is', async () => {
      await seedHealth({
        [cooldownKey(C)]: { ok: NOW - MIN, ms: 200 },
        [cooldownKey(A)]: { ok: NOW - MIN, ms: 9_000 },
      });
      for (const model of [A, B, C]) reply(model, badField());
      await call();
      expect(generated).toEqual([A, B, C]);
    });

    it('adapts the built-in list used when the model list cannot be fetched', async () => {
      listReply = { status: 500, body: 'internal error' };
      await seedHealth({ [cooldownKey('gemini-3.5-flash')]: { ok: NOW - MIN, ms: 800 } });
      reply('gemini-3.5-flash', ok('L1: え\n'));
      const { result } = await call();
      expect(result?.model).toBe('gemini-3.5-flash');
      expect(generated).toEqual(['gemini-3.5-flash']);
    });

    it('ignores health for a pinned model: it is asked, whatever is known about it', async () => {
      const pinned = gemini({ model: B });
      await seedHealth({
        [cooldownKey(B, pinned)]: { bad: NOW - MIN },
        [cooldownKey(A, pinned)]: { ok: NOW - MIN, ms: 10 },
      });
      reply(B, ok('L1: あ\n'));
      const { result } = await call(0, pinned);
      expect(result?.model).toBe(B);
      expect(generated).toEqual([B]);
      expect(http.mock.calls.some(([r]) => r.url.includes('/v1beta/models?'))).toBe(false);
    });

    it('does not mix up two API keys', async () => {
      const one = gemini({ apiKey: 'key-one' });
      const two = gemini({ apiKey: 'key-two' });
      await seedHealth({ [cooldownKey(B, one)]: { ok: NOW - MIN, ms: 100 } });
      for (const model of [A, B, C]) reply(model, badField());
      await call(0, two);
      expect(generated).toEqual([A, B, C]); // key-two has seen nothing
    });
  });

  describe('storage', () => {
    it('drops entries older than 14 days when it writes', async () => {
      await seedHealth({
        old: { ok: NOW - 15 * DAY, ms: 100 },
        oldBad: { bad: NOW - 20 * DAY },
        empty: {},
        recent: { ok: NOW - 13 * DAY, ms: 100 },
      });
      reply(A, ok('L1: あ\n'));
      await call();
      expect(Object.keys(await readHealth()).sort()).toEqual([cooldownKey(A), 'recent'].sort());
    });

    it('ignores garbage in storage', async () => {
      for (const junk of ['junk', null, [1, 2], 7]) {
        await setJSON(HEALTH, junk);
        generated = [];
        reply(A, ok('L1: あ\n'));
        const { result } = await call();
        expect(result?.model).toBe(A);
        expect(Object.keys(await readHealth())).toEqual([cooldownKey(A)]);
      }
    });

    it('never lets a failing write turn an answer or a fallback into an error', async () => {
      const inner = memoryStorage();
      setKV({ ...inner, set: (key, value) => (key === HEALTH ? Promise.reject(new Error('storage full')) : inner.set(key, value)) });
      reply(A, busy());
      reply(B, ok('L1: あ\n'));
      const { result, error } = await call();
      expect(error).toBeUndefined();
      expect(result?.model).toBe(B);
      expect(generated).toEqual([A, B]);
      expect((await readCooldowns())[cooldownKey(A)]?.reason).toBe('overloaded'); // the cooldown table is unaffected
    });
  });
});

describe('GeminiProvider: first-text timeout', () => {
  it('is 30 s, with an unchanged idle timeout', async () => {
    expect(FIRST_TEXT_TIMEOUT_MS).toBe(30_000);
    reply(A, ok('L1: あ'+String.fromCharCode(92)+'n'));
    await generateWithFallback('test-key', { system: 's', user: 'u', maxOutputTokens: 100, onText: () => undefined }, { onlyModels: [A] });
    const sent = http.mock.calls.map(([r]) => r).filter((r) => r.url.includes(':streamGenerateContent'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.firstByteTimeoutMs).toBe(30_000);
    expect(sent[0]?.idleTimeoutMs).toBe(90_000);
  });

  it('sends thinking level low to Gemini 3 and a 1024 budget to 2.5, and none to Gemma', async () => {
    reply(A, ok('x'), ok('x'));
    reply(B, ok('x'));
    reply('gemma-4-31b-it', ok('x'));
    for (const model of [A, B, 'gemma-4-31b-it']) {
      await generateWithFallback('test-key', { system: 's', user: 'u', maxOutputTokens: 100, onText: () => undefined }, { onlyModels: [model] });
    }
    const configs = http.mock.calls.map(([r]) => r).filter((r) => r.url.includes(':streamGenerateContent'))
      .map((r) => (JSON.parse(r.body ?? '{}') as { generationConfig: { thinkingConfig?: unknown } }).generationConfig.thinkingConfig);
    expect(configs).toEqual([{ thinkingLevel: 'low' }, { thinkingBudget: 1024 }, undefined]);
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

describe('cleanOtherProviders', () => {
  const KEY = 'test-key';
  const mine = (model: string) => cooldownIdOf(KEY, model);
  const groqId = 'groq:https://api.groq.com/openai/v1:abc:llama-3.3-70b-versatile';
  const ollamaId = 'ollama:http://localhost:11434/v1:abc:qwen';

  async function seed() {
    await setJSON('ll3:cooldowns', {
      [mine(A)]: { until: Date.now() + 60_000, reason: 'rate' },
      [groqId]: { until: Date.now() + 60_000, reason: 'quota' },
    });
    await setJSON('ll3:health', { [mine(A)]: { ok: 1 }, [ollamaId]: { ok: 2 } });
    await setJSON(`ll3:models:${mine('')}`, { at: 1, models: [] });
    await setJSON('ll3:models:groq:https://api.groq.com/openai/v1:abc:', { at: 1, models: [] });
    await setJSON(`ll3:badkey:${keyTagOf(KEY)}`, true);
    await setJSON('ll3:badkey:zzz', true);
    await setJSON('ll3:s:id:1', { v: 2 });
    await setJSON('ll3:index', []);
    await setJSON('ll3:settings', { apiKey: KEY, hideTranslation: false });
    await setJSON('ll3:lock', { id: 'x' });
  }

  it('drops other services models lists, cooldowns, health and bad-key marks, and nothing else', async () => {
    await seed();
    await cleanOtherProviders(KEY);
    expect(Object.keys(await getJSON<Record<string, unknown>>('ll3:cooldowns', {}))).toEqual([mine(A)]);
    expect(Object.keys(await getJSON<Record<string, unknown>>('ll3:health', {}))).toEqual([mine(A)]);
    expect((await listKeys()).sort()).toEqual([
      `ll3:badkey:${keyTagOf(KEY)}`, 'll3:cooldowns', 'll3:health', 'll3:index', 'll3:lock', `ll3:models:${mine('')}`, 'll3:s:id:1', 'll3:settings',
    ].sort());
  });

  it('is idempotent and harmless on an empty store', async () => {
    await cleanOtherProviders(KEY);
    expect(await listKeys()).toEqual([]);
    await seed();
    await cleanOtherProviders(KEY);
    const once = (await listKeys()).sort();
    await cleanOtherProviders(KEY);
    expect((await listKeys()).sort()).toEqual(once);
  });
});
