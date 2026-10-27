import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { availability, cooldownId, keyStatus, markKey } from '../src/llm/chain';
import { memoryStorage, setJSON, setKV } from '../src/platform/storage';

const BASE = 'https://generativelanguage.googleapis.com';
const gemini = (apiKey = 'key'): string => apiKey;
/** Cooldown ids carry a fingerprint of the API key. */
const id = (model: string, apiKey = gemini()) => cooldownId(apiKey, model);

async function models(apiKey: string, ...ids: string[]) {
  await setJSON(`ll3:models:${cooldownId(apiKey, '')}`, { at: Date.now(), models: ids.map((m, i) => ({ id: m, label: m, rank: 100 - i })) });
}

describe('availability', () => {
  beforeEach(() => setKV(memoryStorage()));

  it('uses the id format gemini:endpoint:keytag:model', () => {
    expect(id('gemini-3.5-flash')).toMatch(new RegExp(`^gemini:${BASE.replace(/[.]/g, '\\.')}:[0-9a-z]+:gemini-3.5-flash$`));
  });

  it('is ok when nothing is known to be exhausted', async () => {
    await models(gemini(), 'gemini-3.5-flash', 'gemini-3.4-flash');
    expect(await availability(gemini())).toEqual({ ok: true, until: 0 });
  });

  it('reports the earliest reset when every model is out of quota', async () => {
    await models(gemini(), 'gemini-3.5-flash', 'gemini-3.4-flash');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-3.5-flash')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-3.4-flash')]: { until: now + 3_000_000, reason: 'quota' },
    });
    expect(await availability(gemini())).toEqual({ ok: false, until: now + 3_000_000 });
  });

  it('treats busy or rate-limited models as worth trying', async () => {
    await models(gemini(), 'gemini-3.5-flash', 'gemini-3.4-flash');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-3.5-flash')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-3.4-flash')]: { until: now + 60_000, reason: 'overloaded' },
    });
    expect((await availability(gemini())).ok).toBe(true);
    await setJSON('ll3:cooldowns', {
      [id('gemini-3.5-flash')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-3.4-flash')]: { until: now + 60_000, reason: 'rate' },
    });
    expect((await availability(gemini())).ok).toBe(true);
  });

  // Every model under a per-minute cooldown still reads as "worth a tap": availability only
  // says "out for the day" for quota. The chain answers such a tap without a request and reports
  // the real (short) wait as a 'rate' error (tests/chain.test.ts), so the reader is never told
  // that today's quota is over for a one-minute limit.
  it('stays ok when every model is only rate-limited or busy, and names no reset', async () => {
    await models(gemini(), 'gemini-3.5-flash', 'gemini-3.4-flash');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-3.5-flash')]: { until: now + 60_000, reason: 'rate' },
      [id('gemini-3.4-flash')]: { until: now + 90_000, reason: 'rate' },
    });
    expect(await availability(gemini())).toEqual({ ok: true, until: 0 });
    const status = await keyStatus(gemini());
    expect(status).toEqual({ kind: 'ok' });
  });

  // A model that went silent is benched for five minutes: like a busy one, that is a short wait,
  // never "out for the day".
  it('treats models benched for going silent (timeout) like busy ones', async () => {
    await models(gemini(), 'gemini-3.5-flash', 'gemini-3.4-flash');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-3.5-flash')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-3.4-flash')]: { until: now + 300_000, reason: 'timeout' },
    });
    expect(await availability(gemini())).toEqual({ ok: true, until: 0 });
  });

  it('stays ok, and names no reset, when every model was only benched for going silent', async () => {
    await models(gemini(), 'gemini-3.5-flash', 'gemini-3.4-flash');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-3.5-flash')]: { until: now + 240_000, reason: 'timeout' },
      [id('gemini-3.4-flash')]: { until: now + 300_000, reason: 'timeout' },
    });
    expect(await availability(gemini())).toEqual({ ok: true, until: 0 });
    expect(await keyStatus(gemini())).toEqual({ kind: 'ok' });
  });

  // A prompt Gemini rejected (bad-request, six hours) or an answer nothing could be read from
  // (unusable, ten minutes) is no quota news: the button must stay on, and the chain says why.
  it.each(['bad-request', 'unusable'] as const)('stays ok, and names no reset, when every model is benched as %s', async (reason) => {
    await models(gemini(), 'gemini-3.5-flash', 'gemini-3.4-flash');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-3.5-flash')]: { until: now + 6 * 3600_000, reason },
      [id('gemini-3.4-flash')]: { until: now + 600_000, reason },
    });
    expect(await availability(gemini())).toEqual({ ok: true, until: 0 });
    expect(await keyStatus(gemini())).toEqual({ kind: 'ok' });
  });

  it('stays ok when quota is spent on one model and another is only benched as bad-request or unusable', async () => {
    await models(gemini(), 'gemini-3.5-flash', 'gemini-3.4-flash');
    const now = Date.now();
    for (const reason of ['bad-request', 'unusable'] as const) {
      await setJSON('ll3:cooldowns', {
        [id('gemini-3.5-flash')]: { until: now + 5_000_000, reason: 'quota' },
        [id('gemini-3.4-flash')]: { until: now + 600_000, reason },
      });
      expect(await availability(gemini())).toEqual({ ok: true, until: 0 });
    }
  });

  it('is not ok when every model is out of quota or missing', async () => {
    await models(gemini(), 'gemini-3.5-flash', 'gemini-3.4-flash');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-3.5-flash')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-3.4-flash')]: { until: now + 3_000_000, reason: 'not-found' },
    });
    expect(await availability(gemini())).toEqual({ ok: false, until: now + 3_000_000 });
  });

  it('ignores cooldowns that have already ended', async () => {
    await models(gemini(), 'gemini-3.5-flash');
    await setJSON('ll3:cooldowns', { [id('gemini-3.5-flash')]: { until: Date.now() - 1000, reason: 'quota' } });
    expect(await availability(gemini())).toEqual({ ok: true, until: 0 });
  });

  it('is not ok without a key', async () => {
    expect(await availability('')).toEqual({ ok: false, until: 0 });
    expect(await availability('   ')).toEqual({ ok: false, until: 0 });
  });

  describe('with another API key', () => {
    it("is ok when only another key's models are out of quota", async () => {
      const spent = gemini('key-one');
      const fresh = gemini('key-two');
      await models(spent, 'gemini-3.5-flash');
      await models(fresh, 'gemini-3.5-flash');
      await setJSON('ll3:cooldowns', { [id('gemini-3.5-flash', spent)]: { until: Date.now() + 5_000_000, reason: 'quota' } });
      expect((await availability(spent)).ok).toBe(false);
      expect((await availability(fresh)).ok).toBe(true);
    });

    it("does not read another key's model list", async () => {
      // key-two has a list in which its only model is spent; key-one has no list and no cooldowns.
      const one = gemini('key-one');
      const two = gemini('key-two');
      await models(two, 'gemini-3.5-flash');
      await setJSON('ll3:cooldowns', { [id('gemini-3.5-flash', two)]: { until: Date.now() + 5_000_000, reason: 'quota' } });
      expect((await availability(one)).ok).toBe(true);
      expect((await availability(two)).ok).toBe(false);
    });
  });
});

describe('keyStatus', () => {
  beforeEach(() => setKV(memoryStorage()));

  it('is "missing" without a key', async () => {
    expect(await keyStatus('')).toEqual({ kind: 'missing' });
    expect(await keyStatus('   ')).toEqual({ kind: 'missing' });
  });

  it('is "ok" for a key nothing is known against', async () => {
    expect(await keyStatus(gemini())).toEqual({ kind: 'ok' });
    await models(gemini(), 'gemini-3.5-flash');
    expect(await keyStatus(gemini())).toEqual({ kind: 'ok' });
  });

  it('is "resting" until the earliest reset when every model is out of quota', async () => {
    await models(gemini(), 'gemini-3.5-flash', 'gemini-3.4-flash');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-3.5-flash')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-3.4-flash')]: { until: now + 3_000_000, reason: 'quota' },
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
    await models(gemini(), 'gemini-3.5-flash');
    await setJSON('ll3:cooldowns', { [id('gemini-3.5-flash')]: { until: Date.now() + 5_000_000, reason: 'quota' } });
    await markKey(gemini(), true);
    expect(await keyStatus(gemini())).toEqual({ kind: 'bad' });
    await markKey(gemini(), false);
    expect((await keyStatus(gemini())).kind).toBe('resting');
  });
});

describe('availability: tier slots', () => {
  beforeEach(() => setKV(memoryStorage()));

  it('is ok when only Flash is out of quota and Flash-Lite still has some', async () => {
    const flash = Array.from({ length: 8 }, (_, i) => `gemini-3.${9 - i}-flash`);
    await setJSON(`ll3:models:${cooldownId(gemini(), '')}`, {
      at: Date.now(),
      models: [...flash, 'gemini-3.5-flash-lite'].map((m) => ({ id: m, label: m, rank: m.endsWith('lite') ? 135 : 1030 })),
    });
    const until = Date.now() + 3_000_000;
    await setJSON('ll3:cooldowns', Object.fromEntries(flash.map((m) => [id(m), { until, reason: 'quota' }])));
    expect(await availability(gemini())).toEqual({ ok: true, until: 0 });
  });
});
