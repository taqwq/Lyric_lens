/*
 * Runs one generation across every configured provider and model until one works.
 * Free tiers fail in predictable ways (busy models, per-minute and per-day limits),
 * so failures are remembered: a model that is out of daily quota is skipped until
 * its reset instead of burning a request to rediscover it.
 */
import { getJSON, setJSON } from '../platform/storage';
import { LLMError, type LLMErrorKind } from './errors';
import { GeminiProvider } from './gemini';
import { OpenAICompatibleProvider } from './openai';
import { presetFor } from './presets';
import type { GenerateRequest, GenerateResult, ModelInfo, Provider, ProviderConfig } from './types';

const COOLDOWN_KEY = 'll3:cooldowns';
const MODELS_KEY = 'll3:models:';
const MODEL_LIST_TTL = 24 * 60 * 60 * 1000;
const MAX_INLINE_WAIT_MS = 30_000;

export function createProvider(config: ProviderConfig): Provider {
  return config.kind === 'gemini' ? new GeminiProvider(config) : new OpenAICompatibleProvider(config);
}

export function isUsable(config: ProviderConfig): boolean {
  if (!config.enabled) return false;
  const preset = presetFor(config.preset);
  if (preset.needsKey && !config.apiKey.trim()) return false;
  if (config.kind === 'openai' && !(config.baseUrl || preset.baseUrl)) return false;
  return true;
}

/* ---------- cooldowns ---------- */

interface Cooldown { until: number; reason: LLMErrorKind }
type Cooldowns = Record<string, Cooldown>;

/** Short fingerprint of the API key: quotas belong to a key's project, so a second key
 *  must not inherit the first key's exhausted models. */
export function keyTag(config: ProviderConfig): string {
  let h = 0;
  for (const ch of config.apiKey.trim()) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

export function cooldownId(config: ProviderConfig, model: string): string {
  return `${config.preset}:${config.baseUrl}:${keyTag(config)}:${model}`;
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

function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 60_000;
}

function cooldownFor(config: ProviderConfig, error: LLMError): number {
  const now = Date.now();
  switch (error.kind) {
    case 'quota':
      // Google states the exact wait ("retryDelay": "57083s"); otherwise assume the daily reset.
      if (error.retryAfterMs > 60_000) return now + error.retryAfterMs;
      return config.kind === 'gemini' ? nextPacificMidnight(now) : nextUtcMidnight(now);
    case 'rate': return now + Math.max(error.retryAfterMs, 60_000);
    case 'overloaded': return now + 2 * 60_000;
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

const BAD_KEY_PREFIX = 'll3:badkey:';

export type KeyStatus = { kind: 'missing' } | { kind: 'bad' } | { kind: 'resting'; until: number } | { kind: 'ok' };

/** What the settings sheet shows next to a service. Uses only what is already known. */
export async function keyStatus(config: ProviderConfig): Promise<KeyStatus> {
  if (!config.apiKey.trim()) return { kind: 'missing' };
  if (await getJSON<boolean>(BAD_KEY_PREFIX + keyTag(config), false)) return { kind: 'bad' };
  const a = await availability([config]);
  return a.ok ? { kind: 'ok' } : { kind: 'resting', until: a.until };
}

/** Remembers (or clears) that a key was rejected, keyed by its fingerprint. */
export async function markKey(config: ProviderConfig, bad: boolean): Promise<void> {
  if (bad) await setJSON(BAD_KEY_PREFIX + keyTag(config), true);
  else await setJSON(BAD_KEY_PREFIX + keyTag(config), false);
}

export interface Availability {
  /** Some model may answer now (busy/rate-limited models count: they recover in minutes). */
  ok: boolean;
  /** When !ok: the earliest moment a model is expected back (0 if unknown). */
  until: number;
}

/** Answers "is it worth sending a request?" from what we already know, without any
 *  network access, so an exhausted free tier never costs a wasted attempt. */
export async function availability(configs: ProviderConfig[]): Promise<Availability> {
  const usable = configs.filter(isUsable);
  if (!usable.length) return { ok: false, until: 0 };
  const cooldowns = await loadCooldowns();
  let earliest = Infinity;
  for (const config of usable) {
    if (config.model) return { ok: true, until: 0 };
    const cached = await getJSON<{ models: ModelInfo[] } | null>(MODELS_KEY + cooldownId(config, ''), null);
    const ids = cached?.models.filter((m) => m.rank > 0).map((m) => m.id) ?? (config.kind === 'gemini' ? FALLBACK_GEMINI : []);
    if (!ids.length) return { ok: true, until: 0 };
    for (const id of config.kind === 'gemini' ? ids.slice(0, 10) : ids.slice(0, 3)) {
      const cd = cooldowns[cooldownId(config, id)];
      if (!cd || cd.reason === 'overloaded' || cd.reason === 'rate') return { ok: true, until: 0 };
      earliest = Math.min(earliest, cd.until);
    }
  }
  return { ok: false, until: Number.isFinite(earliest) ? earliest : 0 };
}

/* ---------- model lists ---------- */

export async function modelsFor(provider: Provider, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
  const key = MODELS_KEY + cooldownId(provider.config, '');
  if (!opts.refresh) {
    const cached = await getJSON<{ at: number; models: ModelInfo[] } | null>(key, null);
    if (cached && Date.now() - cached.at < MODEL_LIST_TTL && cached.models.length) return cached.models;
  }
  const models = await provider.listModels(opts.signal);
  await setJSON(key, { at: Date.now(), models });
  return models;
}

const FALLBACK_GEMINI = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];

async function candidateModels(provider: Provider, signal?: AbortSignal): Promise<string[]> {
  const { config } = provider;
  if (config.model) return [config.model];
  try {
    const models = await modelsFor(provider, { signal });
    const auto = models.filter((m) => m.rank > 0).map((m) => m.id);
    if (auto.length) return config.kind === 'gemini' ? auto.slice(0, 10) : auto.slice(0, 3);
  } catch (error) {
    // Gemini has known model ids to fall back on; other endpoints do not.
    if (!(error instanceof LLMError) || error.kind === 'auth' || error.kind === 'aborted' || config.kind !== 'gemini') throw error;
  }
  if (config.kind === 'gemini') return FALLBACK_GEMINI;
  throw new LLMError('not-found', '使えるモデルが見つからない。設定でモデルを指定して。');
}

/* ---------- the chain ---------- */

export interface ChainResult extends GenerateResult {
  model: string;
  provider: string;
  /** Set when the stream broke after producing text: the text so far is still usable. */
  error?: LLMError;
}

export interface ChainOptions {
  onStatus?: (text: string) => void;
  signal?: AbortSignal;
}

const PRIORITY: LLMErrorKind[] = ['auth', 'quota', 'rate', 'overloaded', 'blocked', 'timeout', 'network', 'bad-request', 'not-found', 'empty', 'unknown'];
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
  configs: ProviderConfig[],
  request: Omit<GenerateRequest, 'model' | 'signal'>,
  options: ChainOptions = {},
): Promise<ChainResult> {
  const { signal, onStatus } = options;
  const usable = configs.filter(isUsable);
  if (!usable.length) throw new LLMError('auth', 'APIキーが設定されていません。');

  const cooldowns = await loadCooldowns();
  const errors: LLMError[] = [];
  const modelLists = new Map<string, string[]>();
  const badProviders = new Set<string>();
  let skippedForCooldown = 0;
  const busyNow = new Set<string>();

  const remember = async (config: ProviderConfig, model: string, error: LLMError) => {
    const until = cooldownFor(config, error);
    if (!until) return;
    cooldowns[cooldownId(config, model)] = { until, reason: error.kind };
    await setJSON(COOLDOWN_KEY, cooldowns);
  };

  for (let pass = 0; pass <= BUSY_PASS_WAITS_MS.length; pass += 1) {
    if (pass > 0) {
      const wait = BUSY_PASS_WAITS_MS[pass - 1]!;
      for (let left = Math.ceil(wait / 1000); left > 0; left -= 1) {
        onStatus?.(`どのモデルも混雑しています · ${left}秒後にもう一度試します`);
        await sleep(1000, signal);
      }
    }
    const passErrors: LLMError[] = [];

    for (const config of usable) {
      if (badProviders.has(config.id)) continue;
      const provider = createProvider(config);
      const label = presetFor(config.preset).label;
      let models = modelLists.get(config.id);
      if (!models) {
        try {
          models = await candidateModels(provider, signal);
        } catch (error) {
          if (!(error instanceof LLMError)) throw error;
          if (error.kind === 'aborted') throw error;
          error.provider = label;
          passErrors.push(error);
          badProviders.add(config.id);
          if (error.kind === 'auth') await markKey(config, true);
          continue;
        }
        modelLists.set(config.id, models);
      }

      // Models out of quota (or missing) are skipped until their cooldown ends; models that
      // were only busy recently go last. A retry pass only revisits models busy in this run.
      const order: string[] = [];
      const busyLast: string[] = [];
      for (const model of models) {
        // Retry passes only revisit the best two busy models: every attempt may count against quota.
        if (pass > 0) { if (busyNow.has(cooldownId(config, model)) && order.length < 2) order.push(model); continue; }
        const cd = cooldowns[cooldownId(config, model)];
        if (cd && cd.until > Date.now() && !config.model) {
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
          onStatus?.(`${label} · ${shortModel(model)}`);
          let produced = false;
          try {
            const result = await provider.generate({
              ...request,
              model,
              signal,
              onText: (chunk) => {
                // Without a verdict from the consumer, any text counts as output.
                const useful = request.onText(chunk);
                if (useful === undefined || useful) produced = true;
              },
            });
            delete cooldowns[cooldownId(config, model)];
            return { ...result, model, provider: label };
          } catch (raw) {
            if (!(raw instanceof LLMError)) throw raw;
            if (raw.kind === 'aborted') throw raw;
            error = raw;
            error.model = model;
            error.provider = label;
            if (produced) {
              // Keep what arrived; the pipeline asks for the rest in a follow-up round.
              return { finish: 'unknown', finishDetail: error.kind, text: '', model, provider: label, error };
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
        await remember(config, model, error);
        if (error.kind === 'overloaded') busyNow.add(cooldownId(config, model));
        else busyNow.delete(cooldownId(config, model));
        if (error.kind === 'auth') {
          badProviders.add(config.id);
          await markKey(config, true);
          break;
        }
        if (error.kind === 'blocked' && ++blocked >= 2) break; // other models will refuse too
        const reason = error.kind === 'overloaded' ? '混雑' : error.kind === 'quota' ? '今日の上限' : error.kind === 'rate' ? '回数制限' : 'エラー';
        onStatus?.(`${shortModel(model)} が${reason} · 次へ`);
      }
    }

    errors.push(...passErrors);
    const busy = busyNow.size > 0
      && passErrors.every((e) => ['overloaded', 'not-found', 'timeout', 'network', 'quota'].includes(e.kind));
    if (!busy) break;
  }

  if (!errors.length && skippedForCooldown) {
    throw new LLMError('quota', '使えるモデルがすべて上限に達しています。', { status: 429 });
  }
  throw pickReportedError(errors);
}
