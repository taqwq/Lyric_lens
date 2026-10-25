import './setup';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getJSON, memoryStorage, setJSON, setKV } from '../src/platform/storage';
import {
  SERVICE_ORDER,
  defaultSettings,
  hasAnyKey,
  loadSettings,
  newProvider,
  onSettings,
  providerFor,
  setProviderKey,
  updateSettings,
  type Settings,
} from '../src/store/settings';

const KEY = 'll3:settings';
const keysOf = (s: Settings) => Object.fromEntries(s.providers.map((p) => [p.preset, p.apiKey]));

beforeEach(() => setKV(memoryStorage()));

describe('providerFor / newProvider', () => {
  it('builds an enabled provider from its preset', () => {
    expect(providerFor('gemini', 'k')).toEqual({
      id: 'gemini', kind: 'gemini', preset: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'k', model: '', enabled: true,
    });
    expect(providerFor('groq')).toMatchObject({ id: 'groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: '' });
  });

  it('newProvider is the same thing', () => {
    for (const preset of ['gemini', 'groq', 'openrouter', 'ollama', 'custom']) expect(newProvider(preset, 'k')).toEqual(providerFor(preset, 'k'));
  });
});

describe('defaultSettings', () => {
  it('offers exactly gemini, groq and openrouter, in that order, without keys', () => {
    expect(SERVICE_ORDER).toEqual(['gemini', 'groq', 'openrouter']);
    const s = defaultSettings();
    expect(s.providers.map((p) => p.preset)).toEqual(['gemini', 'groq', 'openrouter']);
    expect(s.providers.every((p) => p.enabled && p.apiKey === '' && p.model === '')).toBe(true);
    expect(s.thinking).toBe('low') // fast first lines: measured 65s → 16s on the same song;
    expect(s.hideTranslation).toBe(false);
    expect(hasAnyKey(s)).toBe(false);
  });
});

describe('loadSettings', () => {
  it('returns the defaults when nothing is stored', async () => {
    expect(await loadSettings()).toEqual(defaultSettings());
  });

  it('keeps the three fixed services and their keys, and drops everything else', async () => {
    await setJSON(KEY, {
      providers: [
        { ...providerFor('openrouter', ' or-key '), model: 'ignored' },
        providerFor('cerebras', 'cerebras-key'),
        providerFor('gemini', 'gm-key'),
        { id: 'x', preset: 'custom', apiKey: 'custom-key' },
        null,
      ],
      thinking: 'high',
      hideTranslation: true,
    });
    const s = await loadSettings();
    expect(s.providers.map((p) => p.preset)).toEqual(['gemini', 'groq', 'openrouter']);
    expect(keysOf(s)).toEqual({ gemini: 'gm-key', groq: '', openrouter: 'or-key' });
    expect(s.providers.every((p) => p.model === '' && p.enabled)).toBe(true);
    expect(s.thinking).toBe('high');
    expect(s.hideTranslation).toBe(true);
    expect(hasAnyKey(s)).toBe(true);
  });

  it('normalises thinking and the legacy showTranslation flag', async () => {
    await setJSON(KEY, { providers: [], thinking: 'extreme', showTranslation: false });
    const s = await loadSettings();
    expect(s.thinking).toBe('low');
    expect(s.hideTranslation).toBe(true);
    await setJSON(KEY, { providers: [], thinking: 'low', hideTranslation: false, showTranslation: false });
    expect(await loadSettings()).toMatchObject({ thinking: 'low', hideTranslation: false });
  });

  it('survives stored garbage', async () => {
    await setJSON(KEY, 'not an object');
    expect(await loadSettings()).toEqual(defaultSettings());
    await setJSON(KEY, { providers: 'nope' });
    expect(await loadSettings()).toEqual(defaultSettings());
  });

  it('carries the key over from Lyric Lens v2 once, and stores it', async () => {
    const kv = memoryStorage();
    setKV(kv);
    await kv.set('gemini_api_key', '"legacy-key"');
    const s = await loadSettings();
    expect(keysOf(s)).toEqual({ gemini: 'legacy-key', groq: '', openrouter: '' });
    expect(keysOf(await getJSON<Settings>(KEY, defaultSettings()))).toEqual({ gemini: 'legacy-key', groq: '', openrouter: '' });
  });

  it('prefers stored settings over the v2 key', async () => {
    const kv = memoryStorage();
    setKV(kv);
    await kv.set('gemini_api_key', 'legacy-key');
    await setJSON(KEY, { providers: [providerFor('groq', 'gk')] });
    expect(keysOf(await loadSettings())).toEqual({ gemini: '', groq: 'gk', openrouter: '' });
  });
});

describe('setProviderKey / updateSettings', () => {
  it('trims and stores one key without touching the others', async () => {
    await setProviderKey('groq', 'gk');
    const s = await setProviderKey('gemini', '  gm  ');
    expect(keysOf(s)).toEqual({ gemini: 'gm', groq: 'gk', openrouter: '' });
    expect(keysOf(await loadSettings())).toEqual({ gemini: 'gm', groq: 'gk', openrouter: '' });
  });

  it('clearing a key removes it', async () => {
    await setProviderKey('gemini', 'gm');
    await setProviderKey('gemini', '');
    expect(hasAnyKey(await loadSettings())).toBe(false);
  });

  it('merges into the latest stored settings, so another tab\'s key is not overwritten', async () => {
    await loadSettings();
    // another tab saves a key after this tab last read the settings
    await setJSON(KEY, { providers: [providerFor('openrouter', 'or-key')] });
    const s = await setProviderKey('gemini', 'gm');
    expect(keysOf(s)).toEqual({ gemini: 'gm', groq: '', openrouter: 'or-key' });
  });

  it('notifies listeners with the new settings until they unsubscribe', async () => {
    const seen = vi.fn();
    const off = onSettings(seen);
    await setProviderKey('gemini', 'gm');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(keysOf(seen.mock.calls[0]![0] as Settings).gemini).toBe('gm');
    off();
    await setProviderKey('gemini', 'gm2');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('updateSettings applies any change and sanitises the result', async () => {
    const s = await updateSettings((fresh) => ({ ...fresh, thinking: 'low', hideTranslation: true, providers: [...fresh.providers, providerFor('mistral', 'm')] }));
    expect(s.thinking).toBe('low');
    expect(s.hideTranslation).toBe(true);
    expect(s.providers.map((p) => p.preset)).toEqual(['gemini', 'groq', 'openrouter']);
  });
});

describe('hasAnyKey', () => {
  it('ignores blank keys and disabled providers', () => {
    const s = defaultSettings();
    s.providers[0] = { ...s.providers[0]!, apiKey: '   ' };
    expect(hasAnyKey(s)).toBe(false);
    s.providers[1] = { ...s.providers[1]!, apiKey: 'k', enabled: false };
    expect(hasAnyKey(s)).toBe(false);
    s.providers[2] = { ...s.providers[2]!, apiKey: 'k' };
    expect(hasAnyKey(s)).toBe(true);
  });
});
