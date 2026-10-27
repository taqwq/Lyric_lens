/*
 * Runs one generation across Gemini's models until one works.
 * Free tiers fail in predictable ways (busy models, per-minute and per-day limits),
 * so failures are remembered: a model that is out of daily quota is skipped until
 * its reset instead of burning a request to rediscover it.
 */
import { getJSON, listKeys, remove, setJSON } from '../platform/storage';
import { LLMError, type LLMErrorKind } from './errors';
import { GEMINI_BASE, GeminiProvider, rankGeminiModel } from './gemini';
import type { GenerateRequest, GenerateResult, ModelInfo } from './types';

const COOLDOWN_KEY = 'll3:cooldowns';
const MODELS_KEY = 'll3:models:';
const MODEL_LIST_TTL = 24 * 60 * 60 * 1000;
const MAX_INLINE_WAIT_MS = 30_000;

/* ---------- cooldowns ---------- */

interface Cooldown { until: number; reason: LLMErrorKind }
type Cooldowns = Record<string, Cooldown>;

/** Short fingerprint of the API key: quotas belong to a key's project, so a second key
 *  must not inherit the first key's exhausted models. */
export function keyTag(apiKey: string): string {
  let h = 0;
  for (const ch of apiKey.trim()) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

const ID_PREFIX = `gemini:${GEMINI_BASE}:`;

export function cooldownId(apiKey: string, model: string): string {
  return `${ID_PREFIX}${keyTag(apiKey)}:${model}`;
}

/** Gemini free-tier daily quotas reset at midnight Pacific time. */
export function nextPacificMidnight(now = Date.now()): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  const elapsed = (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return now + (86_400 - elapsed) * 1000 + 60_000;
}

function cooldownFor(error: LLMError): number {
  const now = Date.now();
  switch (error.kind) {
    case 'quota':
      // Google states the exact wait ("retryDelay": "57083s"); otherwise assume the daily reset.
      if (error.retryAfterMs > 60_000) return now + error.retryAfterMs;
      return nextPacificMidnight(now);
    case 'rate': return now + Math.max(error.retryAfterMs, 60_000);
    case 'overloaded': return now + 2 * 60_000;
    // A model that never answered would hang the next tap for as long again; bench it longer than a 503.
    case 'timeout': return now + 5 * 60_000;
    // It answered, but nothing usable: the same prompt is likely to break it again soon.
    case 'unusable': return now + 10 * 60_000;
    case 'not-found': return now + 3 * 24 * 60 * 60_000;
    default: return 0;
  }
}

async function loadCooldowns(): Promise<Cooldowns> {
  const all = await getJSON<Cooldowns>(COOLDOWN_KEY, {});
  const now = Date.now();
  for (const [k, v] of Object.entries(all)) if (!v || v.until <= now) delete all[k];
  return all;
}

export async function clearCooldowns(): Promise<void> {
  await setJSON(COOLDOWN_KEY, {});
}

/* ---------- model health ---------- */

/** What was seen of one model on one key. Times are epoch milliseconds. */
export interface ModelHealth {
  /** Last success. */
  ok?: number;
  /** Time to the first text of recent successes (moving average; the newest counts half). */
  ms?: number;
  /** Last time it was overloaded or went silent. */
  bad?: number;
}
type HealthTable = Record<string, ModelHealth>;

const HEALTH_KEY = 'll3:health';
const HEALTH_KEEP_MS = 14 * 24 * 60 * 60_000;
/** A success older than this says little about how fast the model is today. */
const HEALTH_FRESH_MS = 7 * 24 * 60 * 60_000;
/** A model that failed this recently (and has not answered since) is probably still struggling. */
const HEALTH_BAD_MS = 30 * 60_000;
const HEALTH_ALPHA = 0.5;

async function loadHealth(): Promise<HealthTable> {
  try {
    const all = await getJSON<HealthTable>(HEALTH_KEY, {});
    if (!all || typeof all !== 'object' || Array.isArray(all)) return {};
    const oldest = Date.now() - HEALTH_KEEP_MS;
    for (const [k, v] of Object.entries(all)) if (!v || Math.max(v.ok ?? 0, v.bad ?? 0) < oldest) delete all[k];
    return all;
  } catch {
    return {};
  }
}

/** One read-modify-write at the end of an attempt. It only advises the order of models, so a
 *  storage failure must never turn a good answer (or the next fallback) into an error. */
async function noteHealth(apiKey: string, model: string, outcome: { ms: number } | 'bad'): Promise<void> {
  try {
    const table = await loadHealth();
    const id = cooldownId(apiKey, model);
    const now = Date.now();
    const entry: ModelHealth = { ...table[id] };
    if (outcome === 'bad') {
      entry.bad = now;
    } else {
      entry.ok = now;
      entry.ms = Math.round(Number.isFinite(entry.ms)
        ? HEALTH_ALPHA * outcome.ms + (1 - HEALTH_ALPHA) * entry.ms!
        : outcome.ms);
    }
    table[id] = entry;
    await setJSON(HEALTH_KEY, table);
  } catch { /* advice only */ }
}

/** 0 = Flash, 1 = Flash-Lite, 2 = Gemma (and anything else ranked below them). */
function modelTier(id: string): number {
  const rank = rankGeminiModel(id);
  return rank >= 1000 ? 0 : rank >= 10 ? 1 : 2;
}

/** How many models of each tier are candidates. Without caps the newest Flash models fill the
 *  list and the tiers behind them (with their own, separate quotas) are never reached. */
const TIER_CAPS = [6, 3, 1] as const;

/** The models worth trying, from ids sorted best-rank first: the first few of every tier. The one
 *  place that decides the set, for both the chain and `availability`. Keeps the given order. */
export function selectCandidates(ids: string[]): string[] {
  const taken = [0, 0, 0];
  return ids.filter((id) => {
    const tier = modelTier(id);
    if (taken[tier]! >= TIER_CAPS[tier]!) return false;
    taken[tier]! += 1;
    return true;
  });
}

/** Reorders automatically picked Gemini models by what was seen of them. Flash stays ahead of
 *  Flash-Lite, and both ahead of Gemma, whatever the speed. Within each of those tiers (a stable
 *  sort, so ties keep the given rank order): models that answered within a week and have not
 *  failed since go first, fastest first; models never seen (or seen too long ago) keep their
 *  rank order after them; models that were overloaded or silent in the last half hour, and
 *  have not answered since, go last. `stats` is keyed like `ids`. */
export function orderByHealth(ids: string[], stats: Record<string, ModelHealth | undefined>, now = Date.now()): string[] {
  const bucket = (h: ModelHealth | undefined) => {
    if (!h) return 1;
    const failedSince = h.bad !== undefined && (h.ok === undefined || h.bad > h.ok);
    if (h.ok !== undefined && now - h.ok < HEALTH_FRESH_MS && !failedSince) return 0;
    if (failedSince && now - h.bad! < HEALTH_BAD_MS) return 2;
    return 1;
  };
  return ids
    .map((id, index) => {
      const h = stats[id];
      return { id, index, tier: modelTier(id), bucket: bucket(h), ms: Number.isFinite(h?.ms) ? h!.ms! : Infinity };
    })
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.bucket !== b.bucket) return a.bucket - b.bucket;
      if (a.bucket === 0 && a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
      return a.index - b.index;
    })
    .map((m) => m.id);
}

async function orderedByHealth(apiKey: string, ids: string[]): Promise<string[]> {
  const table = await loadHealth();
  return orderByHealth(ids, Object.fromEntries(ids.map((id) => [id, table[cooldownId(apiKey, id)]])));
}

const BAD_KEY_PREFIX = 'll3:badkey:';

export type KeyStatus = { kind: 'missing' } | { kind: 'bad' } | { kind: 'resting'; until: number } | { kind: 'ok' };

/** What the settings sheet shows next to the key. Uses only what is already known. */
export async function keyStatus(apiKey: string): Promise<KeyStatus> {
  if (!apiKey.trim()) return { kind: 'missing' };
  if (await getJSON<boolean>(BAD_KEY_PREFIX + keyTag(apiKey), false)) return { kind: 'bad' };
  const a = await availability(apiKey);
  return a.ok ? { kind: 'ok' } : { kind: 'resting', until: a.until };
}

/** Remembers (or clears) that a key was rejected, keyed by its fingerprint. */
export async function markKey(apiKey: string, bad: boolean): Promise<void> {
  await setJSON(BAD_KEY_PREFIX + keyTag(apiKey), bad);
}

export interface Availability {
  /** Some model may answer now (busy/rate-limited models count: they recover in minutes). */
  ok: boolean;
  /** When !ok: the earliest moment a model is expected back (0 if unknown). */
  until: number;
}

/** Answers "is it worth sending a request?" from what we already know, without any
 *  network access, so an exhausted free tier never costs a wasted attempt. */
export async function availability(apiKey: string): Promise<Availability> {
  if (!apiKey.trim()) return { ok: false, until: 0 };
  const cooldowns = await loadCooldowns();
  const cached = await getJSON<{ models: ModelInfo[] } | null>(MODELS_KEY + cooldownId(apiKey, ''), null);
  const ids = selectCandidates(cached?.models.filter((m) => m.rank > 0).map((m) => m.id) ?? FALLBACK_GEMINI);
  if (!ids.length) return { ok: true, until: 0 };
  let earliest = Infinity;
  for (const id of ids) {
    const cd = cooldowns[cooldownId(apiKey, id)];
    if (!cd || cd.reason === 'overloaded' || cd.reason === 'timeout' || cd.reason === 'rate') return { ok: true, until: 0 };
    earliest = Math.min(earliest, cd.until);
  }
  return { ok: false, until: Number.isFinite(earliest) ? earliest : 0 };
}

/* ---------- model lists ---------- */

export async function modelsFor(apiKey: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
  const key = MODELS_KEY + cooldownId(apiKey, '');
  if (!opts.refresh) {
    const cached = await getJSON<{ at: number; models: ModelInfo[] } | null>(key, null);
    if (cached && Date.now() - cached.at < MODEL_LIST_TTL && cached.models.length) return cached.models;
  }
  const models = await new GeminiProvider(apiKey).listModels(opts.signal);
  await setJSON(key, { at: Date.now(), models });
  return models;
}

const FALLBACK_GEMINI = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];

async function candidateModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const models = await modelsFor(apiKey, { signal });
    const auto = models.filter((m) => m.rank > 0).map((m) => m.id);
    if (auto.length) return await orderedByHealth(apiKey, selectCandidates(auto));
  } catch (error) {
    // Gemini has known model ids to fall back on.
    if (!(error instanceof LLMError) || error.kind === 'auth' || error.kind === 'aborted') throw error;
  }
  return orderedByHealth(apiKey, selectCandidates(FALLBACK_GEMINI));
}

/** Removes what earlier versions stored for other services (and other keys' bad-key marks),
 *  once per start. Never touches saved translations, the index, the settings or the lock. */
export async function cleanOtherProviders(apiKey: string): Promise<void> {
  try {
    const keep = ID_PREFIX;
    for (const k of await listKeys()) {
      if (k.startsWith(MODELS_KEY) && !k.startsWith(MODELS_KEY + keep)) await remove(k);
      else if (k.startsWith(BAD_KEY_PREFIX) && k !== BAD_KEY_PREFIX + keyTag(apiKey)) await remove(k);
    }
    for (const key of [COOLDOWN_KEY, HEALTH_KEY]) {
      const table = await getJSON<Record<string, unknown> | null>(key, null);
      if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
      const ids = Object.keys(table);
      const foreign = ids.filter((id) => !id.startsWith(keep));
      if (!foreign.length) continue;
      for (const id of foreign) delete table[id];
      await setJSON(key, table);
    }
  } catch { /* housekeeping only */ }
}

/* ---------- the chain ---------- */

export interface ChainResult extends GenerateResult {
  model: string;
  /** Set when the stream broke after producing text: the text so far is still usable. */
  error?: LLMError;
}

export interface ChainOptions {
  onStatus?: (text: string) => void;
  /** Called before every attempt: text from a failed attempt must not leak into the next. */
  onAttempt?: () => void;
  signal?: AbortSignal;
  /** Scripts only: try just these models, whatever their cooldowns say. */
  onlyModels?: string[];
}

// Transient failures outrank quota: if any model was merely busy, trying again soon can work,
// so the reader must not be told to wait until tomorrow.
const PRIORITY: LLMErrorKind[] = ['auth', 'rate', 'overloaded', 'blocked', 'timeout', 'network', 'quota', 'bad-request', 'not-found', 'empty', 'unusable', 'unknown'];
/** When every model is merely busy, wait and go around again before giving up. */
const BUSY_PASS_WAITS_MS = [10_000, 25_000];

function pickReportedError(errors: LLMError[]): LLMError {
  return errors.slice().sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind))[0]
    ?? new LLMError('auth', 'APIキーが設定されていません。');
}

function shortModel(model: string): string {
  return model.replace(/^models\//, '').replace(/^gemini-/, '');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new LLMError('aborted', '中止しました。')); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new LLMError('aborted', '中止しました。')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function generateWithFallback(
  apiKey: string,
  request: Omit<GenerateRequest, 'model' | 'signal'>,
  options: ChainOptions = {},
): Promise<ChainResult> {
  const { signal, onStatus, onlyModels } = options;
  if (!apiKey.trim()) throw new LLMError('auth', 'APIキーが設定されていません。');

  const cooldowns = await loadCooldowns();
  const errors: LLMError[] = [];
  let models: string[] | undefined;
  let skippedForCooldown = 0;
  const busyNow = new Set<string>();
  const provider = new GeminiProvider(apiKey);

  const remember = async (model: string, error: LLMError) => {
    if (error.kind === 'overloaded' || error.kind === 'timeout' || error.kind === 'unusable') await noteHealth(apiKey, model, 'bad');
    const until = cooldownFor(error);
    if (!until) return;
    cooldowns[cooldownId(apiKey, model)] = { until, reason: error.kind };
    await setJSON(COOLDOWN_KEY, cooldowns);
  };

  /** The soonest any candidate comes back, read from the cooldown table (which this run's
   *  failures already updated). A per-minute wait is reported as 'rate', never as the daily quota. */
  const fromCooldown = (base: LLMError | null): LLMError => {
    const now = Date.now();
    let best: Cooldown | null = null;
    for (const m of models ?? []) {
      const cd = cooldowns[cooldownId(apiKey, m)];
      if (cd && cd.reason !== 'not-found' && cd.until > now && (!best || cd.until < best.until)) best = cd;
    }
    const message = base?.message ?? '使えるモデルがすべて上限に達しています。';
    if (!best) return base ?? new LLMError('quota', message, { status: 429 });
    const kind: LLMErrorKind = best.reason === 'quota' ? 'quota' : 'rate';
    const wait = best.until - now;
    const error = new LLMError(kind, message, {
      status: 429,
      // stopFromError reads a quota wait above one minute as the real reset (not Pacific midnight).
      retryAfterMs: kind === 'quota' ? Math.max(60_001, wait) : wait,
      detail: base?.detail,
    });
    if (base) error.model = base.model;
    return error;
  };

  let keyRejected = false;
  for (let pass = 0; pass <= BUSY_PASS_WAITS_MS.length && !keyRejected; pass += 1) {
    if (pass > 0) {
      const wait = BUSY_PASS_WAITS_MS[pass - 1]!;
      for (let left = Math.ceil(wait / 1000); left > 0; left -= 1) {
        onStatus?.(`どのモデルも混雑しています · ${left}秒後にもう一度試します`);
        await sleep(1000, signal);
      }
    }
    const passErrors: LLMError[] = [];

    if (!models) {
      try {
        models = onlyModels?.length ? onlyModels : await candidateModels(apiKey, signal);
      } catch (error) {
        if (!(error instanceof LLMError)) throw error;
        if (error.kind === 'aborted') throw error;
        errors.push(error);
        if (error.kind === 'auth') await markKey(apiKey, true);
        break;
      }
    }

    // Models out of quota, rate-limited, silent (timeout) or missing are skipped until their
    // cooldown ends; models that were only busy recently go last. A retry pass only revisits
    // models busy in this run.
    const order: string[] = [];
    const busyLast: string[] = [];
    for (const model of models) {
      // Retry passes only revisit the best two busy models: every attempt may count against quota.
      if (pass > 0) { if (busyNow.has(cooldownId(apiKey, model)) && order.length < 2) order.push(model); continue; }
      const cd = cooldowns[cooldownId(apiKey, model)];
      if (cd && cd.until > Date.now() && !onlyModels?.length) {
        if (cd.reason === 'overloaded') busyLast.push(model);
        else skippedForCooldown += 1;
        continue;
      }
      order.push(model);
    }
    order.push(...busyLast);

    let blocked = 0;
    for (const model of order) {
      let error: LLMError | null = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        onStatus?.(`Google Gemini · ${shortModel(model)}`);
        options.onAttempt?.();
        let produced = false;
        const startedAt = Date.now();
        let firstTextMs: number | null = null;
        try {
          const result = await provider.generate({
            ...request,
            model,
            signal,
            onText: (chunk) => {
              if (firstTextMs === null && chunk) firstTextMs = Date.now() - startedAt;
              // Without a verdict from the consumer, any text counts as output.
              const useful = request.onText(chunk);
              if (useful === undefined || useful) produced = true;
            },
          });
          // HTTP 200 is not success: a reply the consumer accepted no line from counts as a failure.
          if (!produced) throw new LLMError('unusable', 'Gemini の返事から訳を読み取れませんでした。', { status: 200, detail: result.text.slice(0, 2000) });
          // A model that answered is no longer benched: write that back, or the next tap
          // (often 続きを訳す within minutes) would still try it last or skip it.
          const id = cooldownId(apiKey, model);
          if (cooldowns[id]) { delete cooldowns[id]; await setJSON(COOLDOWN_KEY, cooldowns); }
          // A body that only arrived whole (some managers) has no earlier first text than its end.
          await noteHealth(apiKey, model, { ms: firstTextMs ?? Date.now() - startedAt });
          return { ...result, model };
        } catch (raw) {
          if (!(raw instanceof LLMError)) throw raw;
          if (raw.kind === 'aborted') throw raw;
          error = raw;
          error.model = model;
          if (produced) {
            // Keep what arrived; the pipeline asks for the rest in a follow-up round. Bench the
            // model first, so 続きを訳す does not go straight back to the one that just broke.
            await remember(model, error);
            return { finish: 'unknown', finishDetail: error.kind, text: '', model, error };
          }
          if (error.kind === 'rate' && attempt === 1 && error.retryAfterMs > 0 && error.retryAfterMs <= MAX_INLINE_WAIT_MS) {
            for (let left = Math.ceil((error.retryAfterMs + 500) / 1000); left > 0; left -= 1) {
              onStatus?.(`${shortModel(model)} の回数制限 · ${left}秒後に再試行`);
              await sleep(1000, signal);
            }
            continue;
          }
          // A dropped connection is worth one retry; a model that went silent is likely overloaded.
          if (error.kind === 'network' && attempt === 1) {
            onStatus?.(`${shortModel(model)} · 再接続しています`);
            await sleep(2000, signal);
            continue;
          }
          break;
        }
      }
      if (!error) continue;
      passErrors.push(error);
      await remember(model, error);
      if (error.kind === 'overloaded') busyNow.add(cooldownId(apiKey, model));
      else busyNow.delete(cooldownId(apiKey, model));
      if (error.kind === 'auth') {
        keyRejected = true;
        await markKey(apiKey, true);
        break;
      }
      if (error.kind === 'blocked' && ++blocked >= 2) break; // other models will refuse too
      const reason = error.kind === 'overloaded' ? '混雑' : error.kind === 'timeout' ? '応答なし' : error.kind === 'quota' ? '今日の上限' : error.kind === 'rate' ? '回数制限' : 'エラー';
      onStatus?.(`${shortModel(model)} が${reason} · 次へ`);
    }

    errors.push(...passErrors);
    const busy = busyNow.size > 0
      && passErrors.every((e) => ['overloaded', 'not-found', 'timeout', 'network', 'quota'].includes(e.kind));
    if (!busy) break;
  }

  // Every candidate was skipped: say when the first one is back (a minute or a day), not always "today".
  if (!errors.length && skippedForCooldown) throw fromCooldown(null);
  const reported = pickReportedError(errors);
  // A real quota error often carries no usable reset time; the cooldown table knows when the
  // soonest model returns.
  throw reported.kind === 'quota' ? fromCooldown(reported) : reported;
}
