import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { availability, cooldownId, keyStatus, markKey } from '../src/llm/chain';
import { memoryStorage, setJSON, setKV } from '../src/platform/storage';
import type { ProviderConfig } from '../src/llm/types';
import { newProvider } from '../src/store/settings';

const BASE = 'https://generativelanguage.googleapis.com';
const gemini = (apiKey = 'key', overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({ ...newProvider('gemini', apiKey), ...overrides });
/** Cooldown ids carry a fingerprint of the API key. */
const id = (model: string, config: ProviderConfig = gemini()) => cooldownId(config, model);

async function models(config: ProviderConfig, ...ids: string[]) {
  await setJSON(`ll3:models:${cooldownId(config, '')}`, { at: Date.now(), models: ids.map((m, i) => ({ id: m, label: m, rank: 100 - i })) });
}

describe('availability', () => {
  beforeEach(() => setKV(memoryStorage()));

  it('uses the id format preset:endpoint:keytag:model', () => {
    expect(id('gemini-a')).toMatch(new RegExp(`^gemini:${BASE.replace(/[.]/g, '\\.')}:[0-9a-z]+:gemini-a$`));
  });

  it('is ok when nothing is known to be exhausted', async () => {
    await models(gemini(), 'gemini-a', 'gemini-b');
    expect(await availability([gemini()])).toEqual({ ok: true, until: 0 });
  });

  it('reports the earliest reset when every model is out of quota', async () => {
    await models(gemini(), 'gemini-a', 'gemini-b');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-a')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-b')]: { until: now + 3_000_000, reason: 'quota' },
    });
    expect(await availability([gemini()])).toEqual({ ok: false, until: now + 3_000_000 });
  });

  it('treats busy or rate-limited models as worth trying', async () => {
    await models(gemini(), 'gemini-a', 'gemini-b');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-a')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-b')]: { until: now + 60_000, reason: 'overloaded' },
    });
    expect((await availability([gemini()])).ok).toBe(true);
    await setJSON('ll3:cooldowns', {
      [id('gemini-a')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-b')]: { until: now + 60_000, reason: 'rate' },
    });
    expect((await availability([gemini()])).ok).toBe(true);
  });

  // Every model under a per-minute cooldown still reads as "worth a tap": availability only
  // says "out for the day" for quota. The chain answers such a tap without a request and reports
  // the real (short) wait as a 'rate' error (tests/chain.test.ts), so the reader is never told
  // that today's quota is over for a one-minute limit.
  it('stays ok when every model is only rate-limited or busy, and names no reset', async () => {
    await models(gemini(), 'gemini-a', 'gemini-b');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-a')]: { until: now + 60_000, reason: 'rate' },
      [id('gemini-b')]: { until: now + 90_000, reason: 'rate' },
    });
    expect(await availability([gemini()])).toEqual({ ok: true, until: 0 });
    const status = await keyStatus(gemini());
    expect(status).toEqual({ kind: 'ok' });
  });

  it('ignores cooldowns that have already ended', async () => {
    await models(gemini(), 'gemini-a');
    await setJSON('ll3:cooldowns', { [id('gemini-a')]: { until: Date.now() - 1000, reason: 'quota' } });
    expect(await availability([gemini()])).toEqual({ ok: true, until: 0 });
  });

  it('is ok when a backup provider is still fresh', async () => {
    await models(gemini(), 'gemini-a');
    await setJSON('ll3:cooldowns', { [id('gemini-a')]: { until: Date.now() + 5_000_000, reason: 'quota' } });
    const groq = { ...newProvider('groq', 'gk'), model: 'llama' };
    expect((await availability([gemini(), groq])).ok).toBe(true);
  });

  it('is not ok without any usable provider', async () => {
    expect(await availability([newProvider('gemini', '')])).toEqual({ ok: false, until: 0 });
    expect(await availability([gemini('key', { enabled: false })])).toEqual({ ok: false, until: 0 });
    expect(await availability([])).toEqual({ ok: false, until: 0 });
  });

  it('a pinned model is always worth trying', async () => {
    const pinned = gemini('key', { model: 'gemini-a' });
    await setJSON('ll3:cooldowns', { [id('gemini-a', pinned)]: { until: Date.now() + 5_000_000, reason: 'quota' } });
    expect(await availability([pinned])).toEqual({ ok: true, until: 0 });
  });

  describe('with more than one API key', () => {
    it("is ok when only another key's models are out of quota", async () => {
      const spent = gemini('key-one');
      const fresh = gemini('key-two', { id: 'gemini-2' });
      await models(spent, 'gemini-a');
      await models(fresh, 'gemini-a');
      await setJSON('ll3:cooldowns', { [id('gemini-a', spent)]: { until: Date.now() + 5_000_000, reason: 'quota' } });
      expect((await availability([spent])).ok).toBe(false);
      expect((await availability([fresh])).ok).toBe(true);
      expect((await availability([spent, fresh])).ok).toBe(true);
    });

    it('reports the earliest reset across keys when every key is spent', async () => {
      const one = gemini('key-one');
      const two = gemini('key-two', { id: 'gemini-2' });
      await models(one, 'gemini-a');
      await models(two, 'gemini-a');
      const now = Date.now();
      await setJSON('ll3:cooldowns', {
        [id('gemini-a', one)]: { until: now + 9_000_000, reason: 'quota' },
        [id('gemini-a', two)]: { until: now + 4_000_000, reason: 'quota' },
      });
      expect(await availability([one, two])).toEqual({ ok: false, until: now + 4_000_000 });
    });

    it("does not read another key's model list", async () => {
      // key-two has a list in which its only model is spent; key-one has no list and no cooldowns.
      const one = gemini('key-one');
      const two = gemini('key-two', { id: 'gemini-2' });
      await models(two, 'gemini-a');
      await setJSON('ll3:cooldowns', { [id('gemini-a', two)]: { until: Date.now() + 5_000_000, reason: 'quota' } });
      expect((await availability([one])).ok).toBe(true);
      expect((await availability([two])).ok).toBe(false);
    });
  });
});

describe('keyStatus', () => {
  beforeEach(() => setKV(memoryStorage()));

  it('is "missing" without a key', async () => {
    expect(await keyStatus(newProvider('gemini', ''))).toEqual({ kind: 'missing' });
    expect(await keyStatus(newProvider('gemini', '   '))).toEqual({ kind: 'missing' });
  });

  it('is "ok" for a key nothing is known against', async () => {
    expect(await keyStatus(gemini())).toEqual({ kind: 'ok' });
    await models(gemini(), 'gemini-a');
    expect(await keyStatus(gemini())).toEqual({ kind: 'ok' });
  });

  it('is "resting" until the earliest reset when every model is out of quota', async () => {
    await models(gemini(), 'gemini-a', 'gemini-b');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-a')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-b')]: { until: now + 3_000_000, reason: 'quota' },
    });
    expect(await keyStatus(gemini())).toEqual({ kind: 'resting', until: now + 3_000_000 });
  });

  it('is "bad" for a key that was marked, and only that key', async () => {
    await markKey(gemini('key-one'), true);
    expect(await keyStatus(gemini('key-one'))).toEqual({ kind: 'bad' });
    expect(await keyStatus(gemini('  key-one '))).toEqual({ kind: 'bad' });
    expect(await keyStatus(gemini('key-two'))).toEqual({ kind: 'ok' });
  });

  it('a bad key wins over a cooldown, and forgiving it restores the other states', async () => {
    await models(gemini(), 'gemini-a');
    await setJSON('ll3:cooldowns', { [id('gemini-a')]: { until: Date.now() + 5_000_000, reason: 'quota' } });
    await markKey(gemini(), true);
    expect(await keyStatus(gemini())).toEqual({ kind: 'bad' });
    await markKey(gemini(), false);
    expect((await keyStatus(gemini())).kind).toBe('resting');
  });
});
