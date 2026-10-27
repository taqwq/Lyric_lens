import './setup';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getJSON, memoryStorage, setJSON, setKV } from '../src/platform/storage';
import {
  defaultSettings,
  hasKey,
  loadSettings,
  onSettings,
  setApiKey,
  updateSettings,
  type Settings,
} from '../src/store/settings';

const KEY = 'll3:settings';

beforeEach(() => setKV(memoryStorage()));

describe('defaultSettings', () => {
  it('has no key and shows the translation', () => {
    expect(defaultSettings()).toEqual({ apiKey: '', hideTranslation: false });
    expect(hasKey(defaultSettings())).toBe(false);
  });
});

describe('loadSettings', () => {
  it('returns the defaults when nothing is stored', async () => {
    expect(await loadSettings()).toEqual(defaultSettings());
  });

  it('reads the current shape', async () => {
    await setJSON(KEY, { apiKey: ' gm-key ', hideTranslation: true });
    expect(await loadSettings()).toEqual({ apiKey: 'gm-key', hideTranslation: true });
  });

  it('migrates the v3.0 provider list: only the Gemini key survives', async () => {
    await setJSON(KEY, {
      providers: [
        { id: 'gemini', kind: 'gemini', preset: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'gm-key', model: '', enabled: true },
        { id: 'groq', kind: 'openai', preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gk-other', model: '', enabled: true },
        { id: 'openrouter', kind: 'openai', preset: 'openrouter', baseUrl: '', apiKey: 'or-other', model: '', enabled: true },
        null,
      ],
      thinking: 'high',
      hideTranslation: true,
    });
    expect(await loadSettings()).toEqual({ apiKey: 'gm-key', hideTranslation: true });
  });

  it('drops a Groq or OpenRouter key from old settings that have no Gemini key', async () => {
    await setJSON(KEY, { providers: [{ preset: 'gemini', apiKey: '' }, { preset: 'groq', apiKey: 'gk' }, { preset: 'openrouter', apiKey: 'ork' }], thinking: 'low', hideTranslation: false });
    expect(await loadSettings()).toEqual({ apiKey: '', hideTranslation: false });
  });

  it('finds the Gemini entry by kind when the preset is missing', async () => {
    await setJSON(KEY, { providers: [{ kind: 'openai', apiKey: 'x' }, { kind: 'gemini', apiKey: 'gm' }] });
    expect((await loadSettings()).apiKey).toBe('gm');
  });

  it('reads the legacy showTranslation flag, and hideTranslation wins over it', async () => {
    await setJSON(KEY, { providers: [], showTranslation: false });
    expect((await loadSettings()).hideTranslation).toBe(true);
    await setJSON(KEY, { apiKey: '', hideTranslation: false, showTranslation: false });
    expect((await loadSettings()).hideTranslation).toBe(false);
  });

  it('survives stored garbage', async () => {
    await setJSON(KEY, 'not an object');
    expect(await loadSettings()).toEqual(defaultSettings());
    await setJSON(KEY, { providers: 'nope', apiKey: 42 });
    expect(await loadSettings()).toEqual(defaultSettings());
  });

  it('carries the key over from Lyric Lens v2 once, and stores it', async () => {
    const kv = memoryStorage();
    setKV(kv);
    await kv.set('gemini_api_key', '"legacy-key"');
    expect((await loadSettings()).apiKey).toBe('legacy-key');
    expect((await getJSON<Settings>(KEY, defaultSettings())).apiKey).toBe('legacy-key');
  });

  it('prefers stored settings over the v2 key', async () => {
    const kv = memoryStorage();
    setKV(kv);
    await kv.set('gemini_api_key', 'legacy-key');
    await setJSON(KEY, { apiKey: '', hideTranslation: false });
    expect((await loadSettings()).apiKey).toBe('');
  });
});

describe('setApiKey / updateSettings', () => {
  it('trims and stores the key', async () => {
    const s = await setApiKey('  gm  ');
    expect(s.apiKey).toBe('gm');
    expect((await loadSettings()).apiKey).toBe('gm');
  });

  it('clearing the key removes it', async () => {
    await setApiKey('gm');
    await setApiKey('');
    expect(hasKey(await loadSettings())).toBe(false);
  });

  it("merges into the latest stored settings, so another tab's choice is not overwritten", async () => {
    await loadSettings();
    await setJSON(KEY, { apiKey: 'gm', hideTranslation: true }); // another tab
    const s = await updateSettings((fresh) => ({ ...fresh }));
    expect(s).toEqual({ apiKey: 'gm', hideTranslation: true });
  });

  it('notifies listeners with the new settings until they unsubscribe', async () => {
    const seen = vi.fn();
    const off = onSettings(seen);
    await setApiKey('gm');
    expect(seen).toHaveBeenCalledTimes(1);
    expect((seen.mock.calls[0]![0] as Settings).apiKey).toBe('gm');
    off();
    await setApiKey('gm2');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('updateSettings applies any change and sanitises the result', async () => {
    const s = await updateSettings((fresh) => ({ ...fresh, apiKey: ' k ', hideTranslation: true }));
    expect(s).toEqual({ apiKey: 'k', hideTranslation: true });
  });
});

describe('hasKey', () => {
  it('ignores a blank key', () => {
    expect(hasKey({ ...defaultSettings(), apiKey: '   ' })).toBe(false);
    expect(hasKey({ ...defaultSettings(), apiKey: 'k' })).toBe(true);
  });
});
