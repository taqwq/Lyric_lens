import { getJSON, listKeys, remove, setJSON } from '../platform/storage';
import type { SongRecord } from '../core/types';

const SONG_PREFIX = 'll3:song:';
const INDEX_KEY = 'll3:songs';
const MAX_SONGS = 200;

type Index = Record<string, number>;

function songKey(path: string): string {
  return SONG_PREFIX + path;
}

export async function loadSong(path: string): Promise<SongRecord | null> {
  const record = await getJSON<SongRecord | null>(songKey(path), null);
  if (!record || record.v !== 1 || typeof record.lines !== 'object') return null;
  return record;
}

export async function saveSong(record: SongRecord): Promise<void> {
  record.updatedAt = Date.now();
  await setJSON(songKey(record.path), record);
  const index = await getJSON<Index>(INDEX_KEY, {});
  index[record.path] = record.updatedAt;
  const paths = Object.keys(index);
  if (paths.length > MAX_SONGS) {
    paths.sort((a, b) => (index[b] ?? 0) - (index[a] ?? 0));
    for (const old of paths.slice(MAX_SONGS)) {
      delete index[old];
      await remove(songKey(old));
    }
  }
  await setJSON(INDEX_KEY, index);
}

export async function deleteSong(path: string): Promise<void> {
  await remove(songKey(path));
  const index = await getJSON<Index>(INDEX_KEY, {});
  delete index[path];
  await setJSON(INDEX_KEY, index);
}

export async function songCount(): Promise<number> {
  return Object.keys(await getJSON<Index>(INDEX_KEY, {})).length;
}

export async function deleteAllSongs(): Promise<void> {
  for (const key of await listKeys()) if (key.startsWith(SONG_PREFIX)) await remove(key);
  await setJSON(INDEX_KEY, {});
}

/** Coalesces frequent saves while a translation streams in. */
export class SaveQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: SongRecord | null = null;
  constructor(private readonly delayMs = 1200) {}

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
