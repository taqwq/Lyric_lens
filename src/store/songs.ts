import { getJSON, getRaw, listKeys, remove, setJSON } from '../platform/storage';
import { NOTE_KINDS, type LineResult, type Note, type SongContext, type SongRecord, type StopInfo, type StopReason } from '../core/types';

const SONG_PREFIX = 'll3:s:';
const INDEX_KEY = 'll3:index';
const MAX_SONGS = 300;
/** touchSong writes the index at most this often per song. */
const TOUCH_INTERVAL_MS = 6 * 3_600_000;
/** An export file is a few MB at most; anything far beyond that is not one of ours. */
const MAX_IMPORT_CHARS = 64 * 1024 * 1024;

/** id → [last read or saved at, partial?1:0] */
type Index = Record<string, [number, number]>;

function songKey(id: string): string {
  return SONG_PREFIX + id;
}

function isRecord(value: unknown): value is SongRecord {
  const r = value as Partial<SongRecord> | null;
  return Boolean(r) && typeof r === 'object' && r!.v === 2 && typeof r!.lines === 'object' && r!.lines !== null && !Array.isArray(r!.lines);
}

export async function loadSong(id: string): Promise<SongRecord | null> {
  const record = await getJSON<SongRecord | null>(songKey(id), null);
  return isRecord(record) ? record : null;
}

/** Saves a record and evicts the least recently used finished songs beyond the cap.
 *  A partial song is never evicted: it holds work the reader may still resume. */
export async function saveSong(record: SongRecord): Promise<void> {
  record.updatedAt = Date.now();
  await setJSON(songKey(record.id), record);
  const index = await getJSON<Index>(INDEX_KEY, {});
  index[record.id] = [record.updatedAt, record.stop ? 1 : 0];
  const ids = Object.keys(index);
  if (ids.length > MAX_SONGS) {
    const evictable = ids.filter((id) => !index[id]?.[1]).sort((a, b) => (index[a]?.[0] ?? 0) - (index[b]?.[0] ?? 0));
    for (const old of evictable.slice(0, ids.length - MAX_SONGS)) {
      delete index[old];
      await remove(songKey(old));
    }
  }
  await setJSON(INDEX_KEY, index);
}

/** Marks a song as read now, so LRU eviction keeps what the reader returns to. Only the
 *  index changes (the record's updatedAt is its translation date, shown in the sheet);
 *  at most one write per song per 6 hours. */
export async function touchSong(id: string): Promise<void> {
  const index = await getJSON<Index>(INDEX_KEY, {});
  const entry = index[id];
  if (!entry || Date.now() - entry[0] < TOUCH_INTERVAL_MS) return;
  entry[0] = Date.now();
  await setJSON(INDEX_KEY, index);
}

export async function deleteSong(id: string): Promise<void> {
  await remove(songKey(id));
  const index = await getJSON<Index>(INDEX_KEY, {});
  delete index[id];
  await setJSON(INDEX_KEY, index);
}

export async function storageSummary(): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  for (const key of await listKeys()) {
    if (!key.startsWith(SONG_PREFIX)) continue;
    count += 1;
    bytes += ((await getRaw(key)) ?? '').length * 2;
  }
  return { count, bytes };
}

export async function deleteAllSongs(): Promise<void> {
  for (const key of await listKeys()) if (key.startsWith(SONG_PREFIX)) await remove(key);
  await setJSON(INDEX_KEY, {});
}

/* ---------- export / import (docs/DESIGN.md §7, 保存データ) ---------- */

const EXPORT_APP = 'lyric-lens';
const EXPORT_VERSION = 1;

/** Every saved song, finished or partial, as one JSON document the reader can keep or move. */
export async function exportSongs(): Promise<string> {
  const songs: SongRecord[] = [];
  for (const key of await listKeys()) {
    if (!key.startsWith(SONG_PREFIX)) continue;
    const record = await loadSong(key.slice(SONG_PREFIX.length));
    if (record) songs.push(record);
  }
  return JSON.stringify({ app: EXPORT_APP, v: EXPORT_VERSION, exportedAt: Date.now(), songs });
}

const isObject = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
/** A usable timestamp, never in the future (a far-future date would make a song immune to LRU). */
const stamp = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.min(x, Date.now()) : fallback);

/** Imported lines go straight to rendering, which reads kind, phrase and text without checks:
 *  keep only well-formed notes and lines, and only the fields we know. */
function cleanNote(raw: unknown): Note | null {
  if (!isObject(raw)) return null;
  const kind = raw.kind as Note['kind'];
  if (!NOTE_KINDS.includes(kind) || typeof raw.phrase !== 'string' || typeof raw.text !== 'string') return null;
  return {
    kind,
    phrase: raw.phrase,
    text: raw.text,
    ...(raw.conjecture === true ? { conjecture: true } : {}),
    ...(typeof raw.genius === 'string' && raw.genius ? { genius: raw.genius } : {}),
  };
}

function cleanLine(raw: unknown): LineResult | null {
  if (!isObject(raw) || typeof raw.ja !== 'string' || !raw.ja.trim()) return null;
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).map(cleanNote).filter((n): n is Note => n !== null);
  return notes.length ? { ja: raw.ja, notes } : { ja: raw.ja };
}

const STOP_REASONS: readonly StopReason[] = ['busy', 'rate', 'quota', 'auth', 'blocked', 'network', 'unusable', 'stopped', 'length', 'closed', 'gaps'];

function cleanStop(raw: unknown, fallbackAt: number): StopInfo | undefined {
  if (!isObject(raw) || !STOP_REASONS.includes(raw.reason as StopReason)) return undefined;
  const until = typeof raw.until === 'number' && Number.isFinite(raw.until) ? raw.until : undefined;
  return { reason: raw.reason as StopReason, at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : fallbackAt, ...(until !== undefined ? { until } : {}) };
}

function cleanContext(raw: unknown): SongContext | undefined {
  if (!isObject(raw) || typeof raw.who !== 'string' || typeof raw.what !== 'string') return undefined;
  const motifs = (Array.isArray(raw.motifs) ? raw.motifs : [])
    .filter((m): m is { en: string; ja: string } => isObject(m) && typeof m.en === 'string' && typeof m.ja === 'string' && Boolean(m.en) && Boolean(m.ja))
    .map((m) => ({ en: m.en, ja: m.ja }));
  return { who: raw.who, what: raw.what, ...(typeof raw.tone === 'string' && raw.tone ? { tone: raw.tone } : {}), ...(motifs.length ? { motifs } : {}) };
}

/** A well-formed record from untrusted input, or null when it is not a usable song:
 *  v 2, a non-empty id, an object of lines, and at least one valid line. */
function cleanRecord(raw: unknown): SongRecord | null {
  if (!isObject(raw) || raw.v !== 2 || typeof raw.id !== 'string' || !raw.id || !isObject(raw.lines)) return null;
  const lines: Record<string, LineResult> = {};
  for (const [key, value] of Object.entries(raw.lines)) {
    if (key === '__proto__') continue;
    const line = cleanLine(value);
    if (line) lines[key] = line;
  }
  if (!Object.keys(lines).length) return null;
  const now = Date.now();
  const updatedAt = stamp(raw.updatedAt, now);
  const song = cleanContext(raw.song);
  const stop = cleanStop(raw.stop, updatedAt);
  return {
    v: 2,
    id: raw.id,
    path: str(raw.path),
    title: str(raw.title),
    artist: str(raw.artist),
    ...(song ? { song } : {}),
    lines,
    ...(stop ? { stop } : {}),
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
    createdAt: stamp(raw.createdAt, updatedAt),
    updatedAt,
  };
}

/** The edition worth keeping: more translated lines first, then a finished one over a cut one,
 *  then the newer. Ties keep what is already saved. */
function rank(r: SongRecord): [number, number, number] {
  return [Object.keys(r.lines).length, r.stop ? 0 : 1, r.updatedAt];
}

function betterThan(incoming: SongRecord, saved: SongRecord): boolean {
  const a = rank(incoming);
  const b = rank(saved);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** Merges an export file into storage and returns how many songs were written. A saved song is
 *  replaced only by a better edition (see betterThan), never by an older or smaller one.
 *  `skipId` is the song a request is writing right now: it is left alone. Throws on text that is
 *  not a Lyric Lens export. Records are not evicted here: the next saveSong trims the oldest
 *  finished songs if the import went past the cap (partial songs stay). */
export async function importSongs(text: string, skipId?: string | null): Promise<number> {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_CHARS) throw new Error('not-an-export');
  const data = JSON.parse(text) as unknown;
  if (!isObject(data) || data.app !== EXPORT_APP || data.v !== EXPORT_VERSION || !Array.isArray(data.songs)) throw new Error('not-an-export');

  const index = await getJSON<Index>(INDEX_KEY, {});
  let written = 0;
  try {
    for (const raw of data.songs) {
      const record = cleanRecord(raw);
      if (!record || record.id === skipId) continue;
      const saved = await loadSong(record.id);
      if (saved && !betterThan(record, saved)) continue;
      await setJSON(songKey(record.id), record);
      // Keep a later last-read time when the song was already known here.
      index[record.id] = [Math.max(index[record.id]?.[0] ?? 0, record.updatedAt), record.stop ? 1 : 0];
      written += 1;
    }
  } finally {
    if (written) await setJSON(INDEX_KEY, index);
  }
  return written;
}

/** Coalesces frequent saves while a translation streams in. */
export class SaveQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: SongRecord | null = null;
  constructor(private readonly delayMs = 700) {}

  schedule(record: SongRecord): void {
    this.pending = record;
    if (!this.timer) this.timer = setTimeout(() => void this.flush().catch((e) => console.error('[Lyric Lens]', e)), this.delayMs);
  }

  /** A failed save keeps the record pending, so the next flush (or schedule) retries it. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const record = this.pending;
    this.pending = null;
    if (record) {
      try {
        await saveSong(record);
      } catch (e) {
        this.pending ??= record;
        throw e;
      }
    }
  }
}
