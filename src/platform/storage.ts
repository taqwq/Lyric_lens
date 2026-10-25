/*
 * Key/value storage over whichever API the userscript manager offers. Values are stored as
 * JSON strings, which every manager (including iOS Userscripts) can persist.
 */

export interface KV {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

function gmKV(): KV | null {
  try {
    if (typeof GM_getValue === 'function' && typeof GM_setValue === 'function') {
      return {
        get: async (k) => { const v = GM_getValue<unknown>(k, undefined); return v == null ? undefined : String(v); },
        set: async (k, v) => GM_setValue(k, v),
        del: async (k) => { if (typeof GM_deleteValue === 'function') GM_deleteValue(k); },
        keys: async () => (typeof GM_listValues === 'function' ? GM_listValues() : []),
      };
    }
  } catch { /* not granted */ }
  try {
    if (typeof GM !== 'undefined' && GM?.getValue && GM.setValue) {
      const api = GM;
      return {
        get: async (k) => { const v = await api.getValue!<unknown>(k, undefined); return v == null ? undefined : String(v); },
        set: (k, v) => api.setValue!(k, v),
        del: async (k) => { await api.deleteValue?.(k); },
        keys: async () => (api.listValues ? api.listValues() : []),
      };
    }
  } catch { /* not granted */ }
  return null;
}

function memoryKV(): KV {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => { map.set(k, v); },
    del: async (k) => { map.delete(k); },
    keys: async () => Array.from(map.keys()),
  };
}

function localKV(prefix: string): KV | null {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    return {
      get: async (k) => ls.getItem(prefix + k) ?? undefined,
      set: async (k, v) => ls.setItem(prefix + k, v),
      del: async (k) => ls.removeItem(prefix + k),
      keys: async () => Object.keys(ls).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
    };
  } catch {
    return null;
  }
}

let kv: KV = gmKV() ?? (__DEV__ ? localKV('lyric-lens-dev:') : null) ?? memoryKV();

/** Tests swap the backend. */
export function setKV(next: KV): void { kv = next; }
export function memoryStorage(): KV { return memoryKV(); }

export async function getJSON<T>(key: string, fallback: T): Promise<T> {
  const raw = await kv.get(key);
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export async function setJSON(key: string, value: unknown): Promise<void> {
  await kv.set(key, JSON.stringify(value));
}

export async function getRaw(key: string): Promise<string | undefined> {
  return kv.get(key);
}

export async function remove(key: string): Promise<void> {
  await kv.del(key);
}

export async function listKeys(): Promise<string[]> {
  return kv.keys();
}
