import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineResult, SongRecord } from '../src/core/types';
import { getJSON, memoryStorage, setJSON, setKV, type KV } from '../src/platform/storage';
import { SaveQueue, deleteSong, exportSongs, importSongs, loadSong, migrateRecord, saveSong, storageSummary, touchSong } from '../src/store/songs';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const HOUR = 3_600_000;
const INDEX_KEY = 'll3:index';
type Index = Record<string, [number, number]>;

/** A memory store that remembers which keys were written. */
function countingStorage(): { kv: KV; sets: string[] } {
  const inner = memoryStorage();
  const sets: string[] = [];
  const kv: KV = { ...inner, set: async (key, value) => { sets.push(key); await inner.set(key, value); } };
  return { kv, sets };
}

function rec(id: string, over: Partial<SongRecord> = {}, lineCount = 3): SongRecord {
  const lines: Record<string, LineResult> = {};
  for (let i = 0; i < lineCount; i++) lines[`${id} line ${i}`] = { ja: `訳${i}` };
  return { v: 2, keyVersion: 1, id, path: `/${id}`, title: `Song ${id}`, artist: 'Artist', lines, createdAt: NOW - 1000, updatedAt: NOW - 1000, ...over };
}

const partial = (id: string, over: Partial<SongRecord> = {}): SongRecord => rec(id, { stop: { reason: 'closed', at: 1 }, ...over });
const readIndex = (): Promise<Index> => getJSON<Index>(INDEX_KEY, {});

/** Writes a record exactly as given (saveSong would stamp updatedAt). */
async function put(record: SongRecord, readAt = record.updatedAt): Promise<void> {
  await setJSON(`ll3:s:${record.id}`, record);
  const index = await readIndex();
  index[record.id] = [readAt, record.stop ? 1 : 0];
  await setJSON(INDEX_KEY, index);
}

/** An export file with the given song entries. */
const file = (songs: unknown[], over: Record<string, unknown> = {}): string => JSON.stringify({ app: 'lyric-lens', v: 1, songs, ...over });

beforeEach(() => {
  setKV(memoryStorage());
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

/* ---------- touchSong ---------- */

describe('touchSong', () => {
  it('bumps the index and leaves the record alone', async () => {
    await saveSong(rec('a'));
    const before = JSON.stringify(await loadSong('a'));
    vi.setSystemTime(NOW + 7 * HOUR);
    await touchSong('a');
    expect((await readIndex()).a).toEqual([NOW + 7 * HOUR, 0]);
    expect(JSON.stringify(await loadSong('a'))).toBe(before);
    expect((await loadSong('a'))!.updatedAt).toBe(NOW);
  });

  it('writes nothing within 6 hours of the last read', async () => {
    const { kv, sets } = countingStorage();
    setKV(kv);
    await saveSong(rec('a'));
    sets.length = 0;
    vi.setSystemTime(NOW + 6 * HOUR - 1);
    await touchSong('a');
    expect(sets).toEqual([]);
    vi.setSystemTime(NOW + 6 * HOUR);
    await touchSong('a');
    expect(sets).toEqual([INDEX_KEY]); // and only the index
  });

  it('does nothing for a song that is not saved', async () => {
    const { kv, sets } = countingStorage();
    setKV(kv);
    vi.setSystemTime(NOW + 100 * HOUR);
    await touchSong('missing');
    expect(sets).toEqual([]);
  });

  it('keeps the partial flag', async () => {
    await saveSong(partial('p'));
    vi.setSystemTime(NOW + 24 * HOUR);
    await touchSong('p');
    expect((await readIndex()).p).toEqual([NOW + 24 * HOUR, 1]);
  });

  /** A saved at t0, B 7 h later, then (optionally) A read 1 h after that, then 299 new songs: 301 in all. */
  async function fillWith(touch: boolean): Promise<void> {
    await saveSong(rec('A'));
    vi.setSystemTime(NOW + 7 * HOUR);
    await saveSong(rec('B'));
    vi.setSystemTime(NOW + 8 * HOUR);
    if (touch) await touchSong('A');
    for (let i = 0; i < 299; i++) {
      vi.setSystemTime(NOW + 8 * HOUR + 1 + i);
      await saveSong(rec(`n${i}`));
    }
  }

  it('without it, the song read every day is the first one evicted', async () => {
    await fillWith(false);
    expect(await loadSong('A')).toBeNull();
    expect(await loadSong('B')).not.toBeNull();
  });

  it('with it, eviction takes the song nobody returned to, and A keeps its translation date', async () => {
    await fillWith(true);
    expect(await loadSong('B')).toBeNull();
    const a = await loadSong('A');
    expect(a).not.toBeNull();
    expect(a!.updatedAt).toBe(NOW);
    expect(Object.keys(await readIndex()).length).toBe(300);
  });
});

/* ---------- eviction ---------- */

describe('eviction', () => {
  it('never removes a partial song, only the oldest finished ones', async () => {
    await saveSong(partial('keep'));
    for (let i = 0; i < 301; i++) {
      vi.setSystemTime(NOW + 1 + i);
      await saveSong(rec(`f${i}`));
    }
    // 302 songs went in: the two oldest finished ones are gone, the partial one (the oldest of all) stays
    expect(await loadSong('keep')).not.toBeNull();
    expect(await loadSong('f0')).toBeNull();
    expect(await loadSong('f1')).toBeNull();
    expect(await loadSong('f2')).not.toBeNull();
    expect(await loadSong('f300')).not.toBeNull();
    expect(Object.keys(await readIndex()).length).toBe(300);
    expect((await storageSummary()).count).toBe(300);
  });

  it('lets the list grow past the cap when everything is partial', async () => {
    for (let i = 0; i < 302; i++) {
      vi.setSystemTime(NOW + i);
      await saveSong(partial(`p${i}`));
    }
    expect((await storageSummary()).count).toBe(302);
    expect(await loadSong('p0')).not.toBeNull();
  });

  it('a song that finishes later becomes evictable', async () => {
    await saveSong(partial('x'));
    await saveSong(rec('x')); // same id, now complete
    expect((await readIndex()).x?.[1]).toBe(0);
  });

  it('deleteSong removes the record and its index entry', async () => {
    await saveSong(rec('a'));
    await deleteSong('a');
    expect(await loadSong('a')).toBeNull();
    expect((await readIndex()).a).toBeUndefined();
  });
});

describe('SaveQueue', () => {
  it('coalesces to the newest record and writes nothing more afterwards', async () => {
    const q = new SaveQueue(700);
    const r1 = rec('one');
    const r2 = rec('two');
    q.schedule(r1);
    q.schedule(r2);
    await q.flush();
    expect(await loadSong('two')).not.toBeNull();
    expect(await loadSong('one')).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await loadSong('one')).toBeNull();
  });

  it('writes by itself after its delay', async () => {
    const q = new SaveQueue(700);
    q.schedule(rec('a'));
    expect(await loadSong('a')).toBeNull();
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(async () => expect(await loadSong('a')).not.toBeNull());
  });

  /** A store whose writes fail while `failing.on` is set. */
  function flakyStorage(): { failing: { on: boolean } } {
    const inner = memoryStorage();
    const failing = { on: true };
    setKV({ ...inner, set: async (key, value) => { if (failing.on) throw new Error('quota'); await inner.set(key, value); } });
    return { failing };
  }

  it('keeps the record pending when the save fails, and saves it on the next flush', async () => {
    const { failing } = flakyStorage();
    const q = new SaveQueue(700);
    q.schedule(rec('a'));
    await expect(q.flush()).rejects.toThrow('quota');
    failing.on = false;
    expect(await loadSong('a')).toBeNull();
    await q.flush();
    expect(await loadSong('a')).not.toBeNull();
  });

  it('keeps a newer record scheduled during the failing save', async () => {
    const { failing } = flakyStorage();
    const q = new SaveQueue(700);
    q.schedule(rec('old'));
    const flushing = q.flush();
    q.schedule(rec('new'));
    await expect(flushing).rejects.toThrow('quota');
    failing.on = false;
    await q.flush();
    expect(await loadSong('new')).not.toBeNull();
    expect(await loadSong('old')).toBeNull();
  });

  it('logs a failed timer save instead of rejecting unhandled', async () => {
    const { failing } = flakyStorage();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = new SaveQueue(700);
    q.schedule(rec('a'));
    await vi.advanceTimersByTimeAsync(700);
    expect(log).toHaveBeenCalled();
    failing.on = false;
    await q.flush();
    expect(await loadSong('a')).not.toBeNull();
    log.mockRestore();
  });
});

/* ---------- loadSong ---------- */

describe('loadSong', () => {
  it('only returns well-formed records', async () => {
    await setJSON('ll3:s:ok', rec('ok'));
    await setJSON('ll3:s:old', { ...rec('old'), v: 1 });
    await setJSON('ll3:s:null', { ...rec('null'), lines: null });
    await setJSON('ll3:s:list', { ...rec('list'), lines: [] });
    await setJSON('ll3:s:str', { ...rec('str'), lines: 'x' });
    expect(await loadSong('ok')).not.toBeNull();
    for (const id of ['old', 'null', 'list', 'str', 'nothing']) expect(await loadSong(id)).toBeNull();
  });
});

/* ---------- export ---------- */

describe('exportSongs', () => {
  it('writes every saved song, finished or partial, and nothing else', async () => {
    await saveSong(rec('a'));
    await saveSong(partial('b'));
    await setJSON('ll3:settings', { providers: [{ apiKey: 'secret-key-value' }] });
    await setJSON('ll3:s:broken', { v: 1 });
    const text = await exportSongs();
    const data = JSON.parse(text) as { app: string; v: number; songs: SongRecord[] };
    expect(data.app).toBe('lyric-lens');
    expect(data.v).toBe(1);
    expect(data.songs.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(data.songs.find((s) => s.id === 'b')!.stop?.reason).toBe('closed');
    expect(text).not.toContain('secret-key-value');
  });

  it('keeps a stop detail and still reads records without one', async () => {
    const detail = { kind: 'bad-request', model: 'gemini-3.5-flash', status: 400, text: 'oops' };
    await saveSong(rec('d', { stop: { reason: 'rejected', at: 5, detail } }));
    await saveSong(rec('n', { stop: { reason: 'closed', at: 5 } }));
    expect((await loadSong('d'))!.stop?.detail).toEqual(detail);
    expect((await loadSong('n'))!.stop).toEqual({ reason: 'closed', at: 5 });
  });

  it('keeps the newer stop reasons through a save and a load', async () => {
    for (const reason of ['rejected', 'no-model', 'empty', 'silent'] as const) {
      await saveSong(rec(reason, { stop: { reason, at: 5 } }));
      expect((await loadSong(reason))!.stop?.reason).toBe(reason);
    }
  });

  it('is an empty list when nothing is saved', async () => {
    expect((JSON.parse(await exportSongs()) as { songs: unknown[] }).songs).toEqual([]);
  });
});

/* ---------- import: the file ---------- */

describe('importSongs: which files are accepted', () => {
  it('restores an export on an empty device with the translation dates and flags intact', async () => {
    const full = rec('full', {
      updatedAt: NOW - 5 * HOUR,
      createdAt: NOW - 9 * HOUR,
      model: 'gemini-3.5-flash',
      song: { who: '俺が聴き手に', what: '自慢の曲', tone: '強気', motifs: [{ en: 'hold up', ja: '待てよ' }] },
    });
    full.lines['full line 0'] = {
      ja: '訳0',
      notes: [{ kind: 'wordplay', phrase: 'a b', text: '掛けている', conjecture: true, genius: '77' }, { kind: 'slang', phrase: 'x', text: '説明' }],
    };
    const cut = partial('cut', { updatedAt: NOW - 2 * HOUR, stop: { reason: 'rate', at: NOW - 2 * HOUR, until: NOW + HOUR } });
    await put(full);
    await put(cut);
    const text = await exportSongs();

    setKV(memoryStorage());
    expect(await importSongs(text)).toBe(2);
    expect(await loadSong('full')).toEqual(full);
    expect(await loadSong('cut')).toEqual(cut);
    expect(await readIndex()).toEqual({ full: [NOW - 5 * HOUR, 0], cut: [NOW - 2 * HOUR, 1] });
    expect((await storageSummary()).count).toBe(2);
  });

  it('importing the same file again writes nothing', async () => {
    await put(rec('a'));
    const text = await exportSongs();
    const { kv, sets } = countingStorage();
    setKV(kv);
    await importSongs(text);
    sets.length = 0;
    expect(await importSongs(text)).toBe(0);
    expect(sets).toEqual([]);
  });

  it.each([
    ['text that is not JSON', 'lyrics, not json'],
    ['an empty string', ''],
    ['null', 'null'],
    ['a number', '42'],
    ['a list', '[]'],
    ['an object from another app', JSON.stringify({ app: 'other', v: 1, songs: [] })],
    ['an object with no app', JSON.stringify({ songs: [] })],
    ['a newer format', JSON.stringify({ app: 'lyric-lens', v: 2, songs: [] })],
    ['an export without a song list', JSON.stringify({ app: 'lyric-lens', v: 1 })],
    ['songs that are not a list', JSON.stringify({ app: 'lyric-lens', v: 1, songs: { a: rec('a') } })],
  ])('throws for %s and touches nothing', async (_name, text) => {
    const { kv, sets } = countingStorage();
    setKV(kv);
    await expect(importSongs(text)).rejects.toThrow();
    expect(sets).toEqual([]);
  });

  it('accepts an empty song list', async () => {
    expect(await importSongs(file([]))).toBe(0);
  });
});

/* ---------- import: validating records ---------- */

describe('importSongs: validating records', () => {
  it('skips records that are not v2 songs with an id and a lines object', async () => {
    const good = rec('good');
    const written = await importSongs(file([
      good,
      { ...rec('v1'), v: 1 },
      { ...rec('nov'), v: undefined },
      { ...rec(''), id: '' },
      { ...rec('num'), id: 5 },
      { ...rec('nolines'), lines: undefined },
      { ...rec('nulllines'), lines: null },
      { ...rec('listlines'), lines: [{ ja: 'x' }] },
      { ...rec('strlines'), lines: 'x' },
      { ...rec('empty'), lines: {} },
      null,
      7,
      'text',
      [],
    ]));
    expect(written).toBe(1);
    expect(Object.keys(await readIndex())).toEqual(['good']);
    expect(await loadSong('good')).toEqual(good);
  });

  it('drops lines without a usable translation, and a song left with none', async () => {
    const mixed = rec('mixed', {}, 0);
    mixed.lines = {
      ok: { ja: '訳' },
      noJa: {} as LineResult,
      numJa: { ja: 5 } as unknown as LineResult,
      blank: { ja: '   ' },
      nul: null as unknown as LineResult,
      text: 'x' as unknown as LineResult,
      list: [] as unknown as LineResult,
    };
    const hollow = rec('hollow', {}, 0);
    hollow.lines = { blank: { ja: '' }, nul: null as unknown as LineResult };
    expect(await importSongs(file([mixed, hollow]))).toBe(1);
    expect((await loadSong('mixed'))!.lines).toEqual({ ok: { ja: '訳' } });
    expect(await loadSong('hollow')).toBeNull();
  });

  it('drops malformed notes (unknown kind, missing phrase or text) and strips unknown fields', async () => {
    const r = rec('n', {}, 0);
    r.lines = {
      one: {
        ja: '訳',
        notes: [
          { kind: 'slang', phrase: 'ok', text: '良い', evil: '<img src=x onerror=alert(1)>' },
          { kind: 'dictionary', phrase: 'p', text: 't' },
          { kind: 'slang', text: 'no phrase' },
          { kind: 'slang', phrase: 'no text' },
          { kind: 'idiom', phrase: 5, text: 't' },
          null,
          'note',
          { kind: 'ambiguous', phrase: 'q', text: 'r', conjecture: 'yes', genius: 12 },
        ],
        extra: 'x',
      } as unknown as LineResult,
      two: { ja: '訳2', notes: 'not a list' } as unknown as LineResult,
    };
    await importSongs(file([{ ...r, junk: { a: 1 }, title: 7 }]));
    const saved = (await loadSong('n'))!;
    expect(saved.lines).toEqual({
      one: { ja: '訳', notes: [{ kind: 'slang', phrase: 'ok', text: '良い' }, { kind: 'ambiguous', phrase: 'q', text: 'r' }] },
      two: { ja: '訳2' },
    });
    expect(saved).not.toHaveProperty('junk');
    expect(saved.title).toBe(''); // a non-string title is not carried over
  });

  it('keeps a valid stop and context, and drops invalid ones', async () => {
    await importSongs(file([
      rec('good', { stop: { reason: 'quota', at: NOW - 100, until: NOW + HOUR }, song: { who: 'a', what: 'b' } }),
      { ...rec('bad'), stop: { reason: 'exploded', at: 1 }, song: { who: 'a' } },
      { ...rec('noat'), stop: { reason: 'busy' } },
    ]));
    expect((await loadSong('good'))!.stop).toEqual({ reason: 'quota', at: NOW - 100, until: NOW + HOUR });
    expect((await loadSong('good'))!.song).toEqual({ who: 'a', what: 'b' });
    const bad = (await loadSong('bad'))!;
    expect(bad.stop).toBeUndefined();
    expect(bad.song).toBeUndefined();
    expect((await readIndex()).bad).toEqual([NOW - 1000, 0]);
    expect((await loadSong('noat'))!.stop).toEqual({ reason: 'busy', at: NOW - 1000 });
    expect((await readIndex()).noat?.[1]).toBe(1);
  });

  it('ignores a __proto__ key among the lines', async () => {
    const text = `{"app":"lyric-lens","v":1,"songs":[{"v":2,"id":"p","lines":{"__proto__":{"ja":"x"},"k":{"ja":"ok"}},"updatedAt":1}]}`;
    expect(await importSongs(text)).toBe(1);
    const lines = (await loadSong('p'))!.lines;
    expect(Object.keys(lines)).toEqual(['k']);
    expect(({} as Record<string, unknown>).ja).toBeUndefined();
  });

  it('never trusts a date: the future is clamped to now and a missing one becomes now', async () => {
    await importSongs(file([
      rec('future', { updatedAt: NOW + 400 * 24 * HOUR, createdAt: NOW + 500 * 24 * HOUR }),
      { ...rec('nodate'), updatedAt: undefined, createdAt: 'yesterday' },
    ]));
    const future = (await loadSong('future'))!;
    expect(future.updatedAt).toBe(NOW);
    expect(future.createdAt).toBe(NOW);
    expect((await readIndex()).future?.[0]).toBe(NOW);
    const nodate = (await loadSong('nodate'))!;
    expect(nodate.updatedAt).toBe(NOW);
    expect(nodate.createdAt).toBe(NOW);
  });

  it('leaves out the song a request is writing', async () => {
    expect(await importSongs(file([rec('busy'), rec('free')]), 'busy')).toBe(1);
    expect(await loadSong('busy')).toBeNull();
    expect(await loadSong('free')).not.toBeNull();
    expect(Object.keys(await readIndex())).toEqual(['free']);
  });
});

/* ---------- import: merging ---------- */

describe('importSongs: merging with what is saved', () => {
  it('does not replace a saved song that has more lines, even when the file is newer', async () => {
    const saved = rec('s', { updatedAt: NOW - 10 * HOUR }, 5);
    await put(saved);
    expect(await importSongs(file([rec('s', { updatedAt: NOW - HOUR }, 3)]))).toBe(0);
    expect(await loadSong('s')).toEqual(saved);
  });

  it('does not replace a saved song with the same lines that is newer', async () => {
    const saved = rec('s', { updatedAt: NOW - HOUR, title: 'local edition' });
    await put(saved);
    expect(await importSongs(file([rec('s', { updatedAt: NOW - 10 * HOUR, title: 'older file' })]))).toBe(0);
    expect((await loadSong('s'))!.title).toBe('local edition');
  });

  it('does not replace a finished song with a cut one of the same size, however new', async () => {
    const saved = rec('s', { updatedAt: NOW - 10 * HOUR });
    await put(saved);
    expect(await importSongs(file([partial('s', { updatedAt: NOW - HOUR })]))).toBe(0);
    expect((await loadSong('s'))!.stop).toBeUndefined();
  });

  it('replaces a saved song with a better edition: more lines', async () => {
    await put(partial('s', { updatedAt: NOW - HOUR }));
    const fuller = rec('s', { updatedAt: NOW - 20 * HOUR, title: 'fuller' }, 6);
    expect(await importSongs(file([fuller]))).toBe(1);
    const saved = (await loadSong('s'))!;
    expect(Object.keys(saved.lines).length).toBe(6);
    expect(saved.title).toBe('fuller');
    expect(saved.stop).toBeUndefined();
    expect(saved.updatedAt).toBe(NOW - 20 * HOUR);
  });

  it('replaces on a tie in size when the file is finished while the saved song is cut, or newer', async () => {
    await put(partial('cut', { updatedAt: NOW - HOUR }));
    await put(rec('old', { updatedAt: NOW - 10 * HOUR, title: 'old' }));
    expect(await importSongs(file([
      rec('cut', { updatedAt: NOW - 50 * HOUR }),
      rec('old', { updatedAt: NOW - 2 * HOUR, title: 'new' }),
    ]))).toBe(2);
    expect((await loadSong('cut'))!.stop).toBeUndefined();
    expect((await loadSong('old'))!.title).toBe('new');
    expect((await readIndex()).cut?.[1]).toBe(0);
  });

  it('keeps a later last-read time for a song that was already known', async () => {
    await put(rec('s', { updatedAt: NOW - 30 * HOUR }, 1), NOW - HOUR);
    expect(await importSongs(file([rec('s', { updatedAt: NOW - 20 * HOUR }, 4)]))).toBe(1);
    expect((await readIndex()).s).toEqual([NOW - HOUR, 0]);
  });

  it('merges file and device: songs only on one side are all there afterwards', async () => {
    await put(rec('here'));
    expect(await importSongs(file([rec('there1'), rec('there2')]))).toBe(2);
    expect((await storageSummary()).count).toBe(3);
    expect(Object.keys(await readIndex()).sort()).toEqual(['here', 'there1', 'there2']);
  });

  it('an imported cut song is protected from eviction like any partial song', async () => {
    await importSongs(file([partial('theirs', { updatedAt: NOW - 100 * HOUR })]));
    for (let i = 0; i < 300; i++) {
      vi.setSystemTime(NOW + 1 + i);
      await saveSong(rec(`f${i}`));
    }
    expect(await loadSong('theirs')).not.toBeNull();
    expect(await loadSong('f0')).toBeNull(); // 301 in all: the oldest finished one made room
    expect(await loadSong('f1')).not.toBeNull();
  });

  it('an import past the cap is trimmed by the next save, oldest finished first', async () => {
    const songs = Array.from({ length: 305 }, (_, i) => rec(`i${i}`, { updatedAt: NOW - (400 - i) * HOUR }));
    expect(await importSongs(file(songs))).toBe(305);
    expect((await storageSummary()).count).toBe(305);
    await saveSong(rec('fresh'));
    expect((await storageSummary()).count).toBe(300);
    expect(await loadSong('i0')).toBeNull();
    expect(await loadSong('i5')).toBeNull();
    expect(await loadSong('i6')).not.toBeNull();
    expect(await loadSong('fresh')).not.toBeNull();
  });
});

describe('keyVersion', () => {
  beforeEach(() => setKV(memoryStorage()));

  it('is written by saveSong', async () => {
    const r = rec('kv');
    delete r.keyVersion;
    await saveSong(r);
    expect((await getJSON<SongRecord>('ll3:s:kv', r))?.keyVersion).toBe(1);
  });

  it('reads as 1 when a saved record has none', async () => {
    const r = rec('old');
    delete r.keyVersion;
    await put(r);
    expect((await loadSong('old'))?.keyVersion).toBe(1);
  });

  it('migrateRecord is a no-op for version 1 and fills in a missing or bad value', () => {
    const a = rec('a');
    const before = JSON.stringify(a);
    expect(migrateRecord(a)).toBe(a);
    expect(JSON.stringify(a)).toBe(before);
    const b = rec('b');
    delete b.keyVersion;
    expect(migrateRecord(b).keyVersion).toBe(1);
    expect(migrateRecord(rec('c', { keyVersion: 0 })).keyVersion).toBe(1);
  });

  it('keeps a positive carried count on import and drops a bad one', async () => {
    expect(await importSongs(file([rec('c1', { carried: 3 }), rec('c2', { carried: -1 })]))).toBe(2);
    expect((await loadSong('c1'))?.carried).toBe(3);
    expect(await loadSong('c2')).not.toHaveProperty('carried');
  });

  it('is set on imported records that lack it', async () => {
    const r = rec('imp');
    delete r.keyVersion;
    expect(await importSongs(file([r]))).toBe(1);
    expect((await loadSong('imp'))?.keyVersion).toBe(1);
  });
});
