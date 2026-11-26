import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJSON, getRaw, memoryStorage, setJSON, setKV, type KV } from '../src/platform/storage';
import { acquireLock, readLock, requestAbort, TAB_ID, type Lock, type LockHandle } from '../src/store/lock';

const KEY = 'll3:lock:song-1';
const KEY2 = 'll3:lock:song-2';
const T0 = Date.UTC(2026, 9, 26, 3, 0);

let kv: KV;
let handles: LockHandle[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  kv = memoryStorage();
  setKV(kv);
  handles = [];
});

afterEach(async () => {
  for (const handle of handles) await handle.release();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** acquireLock waits 80 ms before it re-reads the lock: let the fake clock run past it. */
async function acquire(id = 'song-1', title = 'Song One'): Promise<LockHandle | null> {
  const pending = acquireLock(id, title);
  await vi.advanceTimersByTimeAsync(100);
  const handle = await pending;
  if (handle) handles.push(handle);
  return handle;
}

/** A lock another tab wrote (TAB_ID is fixed per module instance, so any other `tab` string is "someone else"). */
function theirs(over: Partial<Lock> = {}): Lock {
  return { id: 'song-1', title: 'Their Song', tab: 'other-tab', beat: Date.now(), ...over };
}

describe('readLock', () => {
  it('is null when nothing is stored', async () => {
    expect(await readLock('song-1')).toBeNull();
  });

  it('returns a fresh lock as stored', async () => {
    const lock = theirs();
    await setJSON(KEY, lock);
    expect(await readLock('song-1')).toEqual(lock);
  });

  it('a lock is stale only after more than 10 s without a beat', async () => {
    await setJSON(KEY, theirs({ beat: T0 - 10_000 }));
    expect(await readLock('song-1')).not.toBeNull();
    await setJSON(KEY, theirs({ beat: T0 - 10_001 }));
    expect(await readLock('song-1')).toBeNull();
  });

  it('goes stale as the clock runs on', async () => {
    await setJSON(KEY, theirs());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await readLock('song-1')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await readLock('song-1')).toBeNull();
  });
});

describe('acquireLock', () => {
  it('takes a free lock and stores it under this tab', async () => {
    const handle = await acquire('song-1', 'Song One');
    expect(handle).not.toBeNull();
    const expected: Lock = { id: 'song-1', title: 'Song One', tab: TAB_ID, beat: T0 };
    expect(handle!.lock).toEqual(expected);
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(expected);
    expect(await readLock('song-1')).toEqual(expected);
  });

  it('is refused while another tab holds a fresh lock, and leaves it untouched', async () => {
    const other = theirs();
    await setJSON(KEY, other);
    expect(await acquire('song-1')).toBeNull();
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(other);
  });

  it('is not blocked by another tab translating another song', async () => {
    const other = theirs({ id: 'song-2' });
    await setJSON(KEY2, other);
    expect(await acquire('song-1')).not.toBeNull();
    expect(await getJSON<Lock | null>(KEY2, null)).toEqual(other);
    expect(await readLock('song-2')).toEqual(other);
  });

  it('is refused for a lock that is only a little old', async () => {
    await setJSON(KEY, theirs({ beat: T0 - 9_000 }));
    expect(await acquire()).toBeNull();
  });

  it('can take a stale lock (more than 10 s without a beat)', async () => {
    await setJSON(KEY, theirs({ beat: T0 - 10_001 }));
    const handle = await acquire('song-1', 'Song One');
    expect(handle).not.toBeNull();
    expect(await getJSON<Lock | null>(KEY, null)).toEqual({ id: 'song-1', title: 'Song One', tab: TAB_ID, beat: T0 });
  });

  it('this tab may re-take its own lock for the same song', async () => {
    const first = await acquire('song-1');
    expect(first).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    const second = await acquire('song-1');
    expect(second).not.toBeNull();
    expect((await readLock('song-1'))?.tab).toBe(TAB_ID);
  });

  it('locks are per song: holding one song does not stop another from being taken', async () => {
    expect(await acquire('song-1')).not.toBeNull();
    expect(await acquire('song-2')).not.toBeNull();
    expect((await readLock('song-1'))?.id).toBe('song-1');
    expect((await readLock('song-2'))?.id).toBe('song-2');
  });

  it('loses the race when another tab writes during the 80 ms verification window', async () => {
    const pending = acquireLock('song-1', 'Song One');
    await vi.advanceTimersByTimeAsync(10);
    expect((await getJSON<Lock | null>(KEY, null))?.tab).toBe(TAB_ID);
    const winner = theirs({ beat: Date.now() });
    await setJSON(KEY, winner);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeNull();
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(winner);
  });
});

describe('release', () => {
  it('removes our own lock', async () => {
    const handle = (await acquire())!;
    await handle.release();
    expect(await getRaw(KEY)).toBeUndefined();
    expect(await readLock('song-1')).toBeNull();
  });

  it('leaves another tab’s lock alone', async () => {
    const handle = (await acquire())!;
    const other = theirs({ beat: Date.now() });
    await setJSON(KEY, other);
    await handle.release();
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(other);
  });

  it('leaves this tab’s lock on another song alone', async () => {
    const handle = (await acquire('song-1'))!;
    const two = (await acquire('song-2', 'Two'))!;
    await handle.release();
    expect(await getJSON<Lock | null>(KEY2, null)).toEqual(two.lock);
  });

  it('does nothing when the lock is already gone', async () => {
    const handle = (await acquire())!;
    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
    expect(await getRaw(KEY)).toBeUndefined();
  });

  it('stops the heartbeat: nothing is written afterwards', async () => {
    const handle = (await acquire())!;
    handle.start(vi.fn());
    expect(vi.getTimerCount()).toBe(1);
    await handle.release();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await getRaw(KEY)).toBeUndefined();
  });
});

describe('heartbeat', () => {
  it('refreshes the beat every 2 s, so a held lock never goes stale', async () => {
    const handle = (await acquire('song-1', 'Song One'))!;
    handle.start(vi.fn());
    const started = Date.now();

    await vi.advanceTimersByTimeAsync(1_999);
    expect((await readLock('song-1'))?.beat).toBe(T0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await getJSON<Lock | null>(KEY, null)).toEqual({ id: 'song-1', title: 'Song One', tab: TAB_ID, beat: started + 2_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    const lock = await readLock('song-1');
    expect(lock).not.toBeNull();
    expect(lock!.tab).toBe(TAB_ID);
    expect(Date.now() - lock!.beat).toBeLessThanOrEqual(2_000);
    expect(lock).not.toHaveProperty('abort');
  });

  it('does not call onAbort when nobody asked', async () => {
    const onAbort = vi.fn();
    const handle = (await acquire())!;
    handle.start(onAbort);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('stops, and never overwrites, once another tab owns the lock', async () => {
    const onAbort = vi.fn();
    const handle = (await acquire('song-1'))!;
    handle.start(onAbort);

    const other = theirs({ id: 'song-1', beat: Date.now() });
    await setJSON(KEY, other);
    const set = vi.spyOn(kv, 'set');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(other);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(set).not.toHaveBeenCalled();
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(other);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('ignores an abort flag on a lock it no longer owns', async () => {
    const onAbort = vi.fn();
    const handle = (await acquire('song-1'))!;
    handle.start(onAbort);
    await setJSON(KEY, theirs({ beat: Date.now(), abort: true }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onAbort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('writes the lock back if it has vanished from storage', async () => {
    const handle = (await acquire('song-1', 'Song One'))!;
    handle.start(vi.fn());
    await kv.del(KEY);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await readLock('song-1')).toMatchObject({ id: 'song-1', title: 'Song One', tab: TAB_ID });
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('requestAbort', () => {
  it('flags only the named song’s lock', async () => {
    const other = theirs({ id: 'song-2' });
    await setJSON(KEY2, other);
    await requestAbort('song-1');
    expect(await getJSON<Lock | null>(KEY2, null)).toEqual(other);
  });

  it('flags the current lock and leaves the rest of it intact', async () => {
    const other = theirs();
    await setJSON(KEY, other);
    await requestAbort('song-1');
    expect(await getJSON<Lock | null>(KEY, null)).toEqual({ ...other, abort: true });
  });

  it('does nothing when there is no lock', async () => {
    await requestAbort('song-1');
    expect(await getRaw(KEY)).toBeUndefined();
  });

  it('does nothing to a stale lock', async () => {
    const stale = theirs({ beat: T0 - 20_000 });
    await setJSON(KEY, stale);
    await requestAbort('song-1');
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(stale);
  });

  it('makes the owner’s onAbort fire on its next beat', async () => {
    const onAbort = vi.fn();
    const handle = (await acquire('song-1'))!;
    handle.start(onAbort);

    await requestAbort('song-1');
    expect((await readLock('song-1'))?.abort).toBe(true);
    expect(onAbort).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(onAbort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('the owner keeps the lock while it winds down (flag kept, beat refreshed)', async () => {
    const handle = (await acquire('song-1', 'Song One'))!;
    handle.start(vi.fn());
    await requestAbort('song-1');
    await vi.advanceTimersByTimeAsync(2_000);
    const lock = await readLock('song-1');
    expect(lock).toMatchObject({ id: 'song-1', title: 'Song One', tab: TAB_ID, abort: true });
    expect(Date.now() - lock!.beat).toBeLessThanOrEqual(2_000);
  });

  it('a released owner cannot be aborted any more: the lock is gone', async () => {
    const onAbort = vi.fn();
    const handle = (await acquire())!;
    handle.start(onAbort);
    await handle.release();
    await requestAbort('song-1');
    expect(await getRaw(KEY)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('after the owner released, a new tab can take the lock without inheriting the flag', async () => {
    const handle = (await acquire('song-1'))!;
    handle.start(vi.fn());
    await requestAbort('song-1');
    await handle.release();
    const next = await acquire('song-1', 'Again');
    expect(next).not.toBeNull();
    expect(await readLock('song-1')).toEqual({ id: 'song-1', title: 'Again', tab: TAB_ID, beat: next!.lock.beat });
    expect(await readLock('song-1')).not.toHaveProperty('abort');
  });
});
