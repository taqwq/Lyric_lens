import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { availability } from '../src/llm/chain';
import { memoryStorage, setJSON, setKV } from '../src/platform/storage';
import { newProvider } from '../src/store/settings';

const BASE = 'https://generativelanguage.googleapis.com';
const id = (model: string) => `gemini:${BASE}:${model}`;
const gemini = () => newProvider('gemini', 'key');

async function models(...ids: string[]) {
  await setJSON(`ll3:models:${id('')}`, { at: Date.now(), models: ids.map((m, i) => ({ id: m, label: m, rank: 100 - i })) });
}

describe('availability', () => {
  beforeEach(() => setKV(memoryStorage()));

  it('is ok when nothing is known to be exhausted', async () => {
    await models('gemini-a', 'gemini-b');
    expect(await availability([gemini()])).toEqual({ ok: true, until: 0 });
  });

  it('reports the earliest reset when every model is out of quota', async () => {
    await models('gemini-a', 'gemini-b');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-a')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-b')]: { until: now + 3_000_000, reason: 'quota' },
    });
    expect(await availability([gemini()])).toEqual({ ok: false, until: now + 3_000_000 });
  });

  it('treats busy or rate-limited models as worth trying', async () => {
    await models('gemini-a', 'gemini-b');
    const now = Date.now();
    await setJSON('ll3:cooldowns', {
      [id('gemini-a')]: { until: now + 5_000_000, reason: 'quota' },
      [id('gemini-b')]: { until: now + 60_000, reason: 'overloaded' },
    });
    expect((await availability([gemini()])).ok).toBe(true);
  });

  it('is ok when a backup provider is still fresh', async () => {
    await models('gemini-a');
    await setJSON('ll3:cooldowns', { [id('gemini-a')]: { until: Date.now() + 5_000_000, reason: 'quota' } });
    const groq = { ...newProvider('groq', 'gk'), model: 'llama' };
    expect((await availability([gemini(), groq])).ok).toBe(true);
  });

  it('is not ok without any usable provider', async () => {
    expect(await availability([newProvider('gemini', '')])).toEqual({ ok: false, until: 0 });
  });
});
