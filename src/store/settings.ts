/*
 * Settings are tiny and shared by every tab through GM storage. Every change is merged into
 * a fresh read so an older tab never overwrites a key saved in another tab.
 */
import { getJSON, getRaw, setJSON } from '../platform/storage';

export interface Settings {
  /** The Gemini API key ('' = none yet). */
  apiKey: string;
  /** 訳を隠す: remembered per viewer. */
  hideTranslation: boolean;
}

const KEY = 'll3:settings';
const LEGACY_GEMINI_KEY = 'gemini_api_key';

export function defaultSettings(): Settings {
  return { apiKey: '', hideTranslation: false };
}

/** Reads every shape this script has stored: `{ apiKey, hideTranslation }`, the v3.0 provider
 *  list (only the Gemini entry survives), and the even older `showTranslation` flag. */
function sanitize(raw: unknown): Settings {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as {
    apiKey?: unknown; providers?: unknown; hideTranslation?: unknown; showTranslation?: unknown;
  };
  let apiKey = typeof r.apiKey === 'string' ? r.apiKey : '';
  if (!apiKey && Array.isArray(r.providers)) {
    const gemini = r.providers.find((p) => p && typeof p === 'object' && ((p as { preset?: unknown }).preset === 'gemini' || (p as { kind?: unknown }).kind === 'gemini'));
    const key = (gemini as { apiKey?: unknown } | undefined)?.apiKey;
    if (typeof key === 'string') apiKey = key;
  }
  return {
    apiKey: apiKey.trim(),
    hideTranslation: typeof r.hideTranslation === 'boolean' ? r.hideTranslation : r.showTranslation === false,
  };
}

let cached: Settings = defaultSettings();
const listeners = new Set<(s: Settings) => void>();

/** Reads the shared settings (always fresh) and remembers them for synchronous reads. */
export async function loadSettings(): Promise<Settings> {
  const stored = await getJSON<unknown>(KEY, null);
  let settings = sanitize(stored);
  if (!stored) {
    // Carry the key over from Lyric Lens v2 so updating does not ask for it again.
    const legacy = (await getRaw(LEGACY_GEMINI_KEY))?.replace(/^"|"$/g, '').trim();
    if (legacy) {
      settings = { ...settings, apiKey: legacy };
      await setJSON(KEY, settings);
    }
  }
  cached = settings;
  return settings;
}

/** Last settings read by this tab. Call loadSettings() before anything that writes. */
export function currentSettings(): Settings {
  return cached;
}

async function write(next: Settings): Promise<void> {
  cached = sanitize(next);
  await setJSON(KEY, cached);
  listeners.forEach((fn) => fn(cached));
}

/** Applies a change on top of the latest stored settings. */
export async function updateSettings(change: (fresh: Settings) => Settings): Promise<Settings> {
  const fresh = await loadSettings();
  await write(change(fresh));
  return cached;
}

export async function setApiKey(apiKey: string): Promise<Settings> {
  return updateSettings((s) => ({ ...s, apiKey: apiKey.trim() }));
}

export function onSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function hasKey(settings: Settings): boolean {
  return Boolean(settings.apiKey.trim());
}
