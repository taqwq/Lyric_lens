import { getJSON, getRaw, listKeys, remove, setJSON } from '../platform/storage';
import type { SongRecord } from '../core/types';

const SONG_PREFIX = 'll3:s:';
const INDEX_KEY = 'll3:index';
const MAX_SONGS = 300;

/** id → [updatedAt, partial?1:0] */
type Index = Record<string, [number, number]>;

function songKey(id: string): string {
  return SONG_PREFIX + id;
}

export async function loadSong(id: string): Promise<SongRecord | null> {
  const record = await getJSON<SongRecord | null>(songKey(id), null);
  if (!record || record.v !== 2 || typeof record.lines !== 'object') return null;
  return record;
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

/** Coalesces frequent saves while a translation streams in. */
export class SaveQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: SongRecord | null = null;
  constructor(private readonly delayMs = 700) {}

  schedule(record: SongRecord): void {
    this.pending = record;
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const record = this.pending;
    this.pending = null;
    if (record) await saveSong(record);
  }
}
