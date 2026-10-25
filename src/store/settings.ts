import { getJSON, getRaw, remove, setJSON } from '../platform/storage';
import { presetFor } from '../llm/presets';
import type { ProviderConfig, ThinkingLevel } from '../llm/types';

export interface Settings {
  /** Fallback order: the first usable provider is tried first. */
  providers: ProviderConfig[];
  thinking: ThinkingLevel;
  /** Translations visible under the lyrics. */
  showTranslation: boolean;
  /** "この曲について" card above the lyrics. */
  showSummary: boolean;
  /** Translate untranslated songs as soon as the page opens (uses quota on every visit). */
  autoTranslate: boolean;
}

const KEY = 'll3:settings';
const LEGACY_GEMINI_KEY = 'gemini_api_key';

export function newProvider(presetId: string, apiKey = ''): ProviderConfig {
  const preset = presetFor(presetId);
  return {
    id: `${preset.id}-${Math.random().toString(36).slice(2, 8)}`,
    kind: preset.kind,
    preset: preset.id,
    baseUrl: preset.id === 'custom' ? '' : preset.baseUrl,
    apiKey,
    model: '',
    enabled: true,
  };
}

export function defaultSettings(): Settings {
  return {
    providers: [{ ...newProvider('gemini'), id: 'gemini' }],
    thinking: 'medium',
    showTranslation: true,
    showSummary: true,
    autoTranslate: false,
  };
}

function sanitize(raw: Partial<Settings> | null): Settings {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  const providers = Array.isArray(raw.providers)
    ? raw.providers
      .filter((p): p is ProviderConfig => Boolean(p && typeof p === 'object' && typeof p.preset === 'string'))
      .map((p) => ({ ...newProvider(p.preset), ...p, kind: presetFor(p.preset).kind, apiKey: String(p.apiKey ?? ''), model: String(p.model ?? ''), baseUrl: String(p.baseUrl ?? '') }))
    : base.providers;
  return {
    providers: providers.length ? providers : base.providers,
    thinking: raw.thinking === 'low' || raw.thinking === 'high' ? raw.thinking : 'medium',
    showTranslation: raw.showTranslation ?? base.showTranslation,
    showSummary: raw.showSummary ?? base.showSummary,
    autoTranslate: raw.autoTranslate ?? base.autoTranslate,
  };
}

let cached: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;
  const stored = await getJSON<Partial<Settings> | null>(KEY, null);
  let settings = sanitize(stored);
  if (!stored) {
    // Carry the key over from Lyric Lens v2 so updating does not ask for it again.
    const legacy = (await getRaw(LEGACY_GEMINI_KEY))?.replace(/^"|"$/g, '').trim();
    if (legacy) {
      settings = { ...settings, providers: [{ ...settings.providers[0]!, apiKey: legacy }] };
      await setJSON(KEY, settings);
      await remove(LEGACY_GEMINI_KEY);
    }
  }
  cached = settings;
  return settings;
}

export function currentSettings(): Settings {
  return cached ?? defaultSettings();
}

export async function saveSettings(next: Settings): Promise<void> {
  cached = sanitize(next);
  await setJSON(KEY, cached);
  listeners.forEach((fn) => fn(cached!));
}

export async function patchSettings(patch: Partial<Settings>): Promise<void> {
  await saveSettings({ ...currentSettings(), ...patch });
}

export function onSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function hasAnyKey(settings: Settings): boolean {
  return settings.providers.some((p) => p.enabled && (p.apiKey.trim() || !presetFor(p.preset).needsKey));
}
