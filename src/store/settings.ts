/*
 * Settings are tiny and shared by every tab through GM storage. Every change is merged into
 * a fresh read so an older tab never overwrites a key saved in another tab.
 */
import { getJSON, getRaw, setJSON } from '../platform/storage';
import { presetFor } from '../llm/presets';
import type { ProviderConfig, ThinkingLevel } from '../llm/types';

/** The services offered, in fallback order (docs/DESIGN.md §7). */
export const SERVICE_ORDER = ['gemini', 'groq', 'openrouter'] as const;

export interface Settings {
  /** One row per service in SERVICE_ORDER; a row is used when it has a key. */
  providers: ProviderConfig[];
  /** Engine detail, not exposed in the UI. */
  thinking: ThinkingLevel;
  /** 訳を隠す: remembered per viewer. */
  hideTranslation: boolean;
}

const KEY = 'll3:settings';
const LEGACY_GEMINI_KEY = 'gemini_api_key';

export function providerFor(presetId: string, apiKey = ''): ProviderConfig {
  const preset = presetFor(presetId);
  return { id: preset.id, kind: preset.kind, preset: preset.id, baseUrl: preset.baseUrl, apiKey, model: '', enabled: true };
}

/** Kept for tests and tools that build ad-hoc providers. */
export function newProvider(presetId: string, apiKey = ''): ProviderConfig {
  return providerFor(presetId, apiKey);
}

export function defaultSettings(): Settings {
  return { providers: SERVICE_ORDER.map((id) => providerFor(id)), thinking: 'medium', hideTranslation: false };
}

function sanitize(raw: Partial<Settings> & { showTranslation?: boolean } | null): Settings {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  const stored = Array.isArray(raw.providers) ? raw.providers : [];
  const keyFor = (preset: string) => String(stored.find((p) => p && p.preset === preset && p.apiKey)?.apiKey ?? '').trim();
  return {
    providers: SERVICE_ORDER.map((id) => providerFor(id, keyFor(id))),
    thinking: raw.thinking === 'low' || raw.thinking === 'high' ? raw.thinking : 'medium',
    hideTranslation: typeof raw.hideTranslation === 'boolean' ? raw.hideTranslation : raw.showTranslation === false,
  };
}

let cached: Settings = defaultSettings();
const listeners = new Set<(s: Settings) => void>();

/** Reads the shared settings (always fresh) and remembers them for synchronous reads. */
export async function loadSettings(): Promise<Settings> {
  const stored = await getJSON<Partial<Settings> | null>(KEY, null);
  let settings = sanitize(stored);
  if (!stored) {
    // Carry the key over from Lyric Lens v2 so updating does not ask for it again.
    const legacy = (await getRaw(LEGACY_GEMINI_KEY))?.replace(/^"|"$/g, '').trim();
    if (legacy) {
      settings = { ...settings, providers: settings.providers.map((p) => (p.preset === 'gemini' ? { ...p, apiKey: legacy } : p)) };
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

export async function setProviderKey(preset: string, apiKey: string): Promise<Settings> {
  return updateSettings((s) => ({ ...s, providers: s.providers.map((p) => (p.preset === preset ? { ...p, apiKey: apiKey.trim() } : p)) }));
}

export function onSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function hasAnyKey(settings: Settings): boolean {
  return settings.providers.some((p) => p.enabled && p.apiKey.trim());
}
