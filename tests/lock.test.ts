import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJSON, getRaw, memoryStorage, setJSON, setKV, type KV } from '../src/platform/storage';
import { acquireLock, readLock, requestAbort, TAB_ID, type Lock, type LockHandle } from '../src/store/lock';

const KEY = 'll3:lock';
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
  return { id: 'song-9', title: 'Their Song', tab: 'other-tab', beat: Date.now(), ...over };
}

describe('readLock', () => {
  it('is null when nothing is stored', async () => {
    expect(await readLock()).toBeNull();
  });

  it('returns a fresh lock as stored', async () => {
    const lock = theirs();
    await setJSON(KEY, lock);
    expect(await readLock()).toEqual(lock);
  });

  it('a lock is stale only after more than 10 s without a beat', async () => {
    await setJSON(KEY, theirs({ beat: T0 - 10_000 }));
    expect(await readLock()).not.toBeNull();
    await setJSON(KEY, theirs({ beat: T0 - 10_001 }));
    expect(await readLock()).toBeNull();
  });

  it('goes stale as the clock runs on', async () => {
    await setJSON(KEY, theirs());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await readLock()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await readLock()).toBeNull();
  });
});

describe('acquireLock', () => {
  it('takes a free lock and stores it under this tab', async () => {
    const handle = await acquire('song-1', 'Song One');
    expect(handle).not.toBeNull();
    const expected: Lock = { id: 'song-1', title: 'Song One', tab: TAB_ID, beat: T0 };
    expect(handle!.lock).toEqual(expected);
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(expected);
    expect(await readLock()).toEqual(expected);
  });

  it('is refused while another tab holds a fresh lock, and leaves it untouched', async () => {
    const other = theirs();
    await setJSON(KEY, other);
    expect(await acquire('song-1')).toBeNull();
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(other);
  });

  it('is refused even for the same song if another tab holds it', async () => {
    const other = theirs({ id: 'song-1' });
    await setJSON(KEY, other);
    expect(await acquire('song-1')).toBeNull();
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(other);
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
    expect((await readLock())?.tab).toBe(TAB_ID);
  });

  it('this tab is refused a second song while it holds a lock (one in-flight request across songs)', async () => {
    expect(await acquire('song-1')).not.toBeNull();
    expect(await acquire('song-2')).toBeNull();
    expect((await readLock())?.id).toBe('song-1');
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

  it('also loses when the winner is another song from this very tab id', async () => {
    const pending = acquireLock('song-1', 'Song One');
    await vi.advanceTimersByTimeAsync(10);
    await setJSON(KEY, { id: 'song-2', title: 'Two', tab: TAB_ID, beat: Date.now() });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeNull();
  });
});

describe('release', () => {
  it('removes our own lock', async () => {
    const handle = (await acquire())!;
    await handle.release();
    expect(await getRaw(KEY)).toBeUndefined();
    expect(await readLock()).toBeNull();
  });

  it('leaves another tab’s lock alone', async () => {
    const handle = (await acquire())!;
    const other = theirs({ beat: Date.now() });
    await setJSON(KEY, other);
    await handle.release();
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(other);
  });

  it('leaves a lock this tab holds for another song alone', async () => {
    const handle = (await acquire('song-1'))!;
    const mine = { id: 'song-2', title: 'Two', tab: TAB_ID, beat: Date.now() };
    await setJSON(KEY, mine);
    await handle.release();
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(mine);
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
    expect((await readLock())?.beat).toBe(T0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await getJSON<Lock | null>(KEY, null)).toEqual({ id: 'song-1', title: 'Song One', tab: TAB_ID, beat: started + 2_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    const lock = await readLock();
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

  it('stops when the stored lock is this tab’s but for another song', async () => {
    const handle = (await acquire('song-1'))!;
    handle.start(vi.fn());
    const mine = { id: 'song-2', title: 'Two', tab: TAB_ID, beat: Date.now() };
    await setJSON(KEY, mine);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(mine);
  });

  it('writes the lock back if it has vanished from storage', async () => {
    const handle = (await acquire('song-1', 'Song One'))!;
    handle.start(vi.fn());
    await kv.del(KEY);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await readLock()).toMatchObject({ id: 'song-1', title: 'Song One', tab: TAB_ID });
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('requestAbort', () => {
  it('flags the current lock and leaves the rest of it intact', async () => {
    const other = theirs();
    await setJSON(KEY, other);
    await requestAbort();
    expect(await getJSON<Lock | null>(KEY, null)).toEqual({ ...other, abort: true });
  });

  it('does nothing when there is no lock', async () => {
    await requestAbort();
    expect(await getRaw(KEY)).toBeUndefined();
  });

  it('does nothing to a stale lock', async () => {
    const stale = theirs({ beat: T0 - 20_000 });
    await setJSON(KEY, stale);
    await requestAbort();
    expect(await getJSON<Lock | null>(KEY, null)).toEqual(stale);
  });

  it('makes the owner’s onAbort fire on its next beat', async () => {
    const onAbort = vi.fn();
    const handle = (await acquire('song-1'))!;
    handle.start(onAbort);

    await requestAbort();
    expect((await readLock())?.abort).toBe(true);
    expect(onAbort).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(onAbort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('the owner keeps the lock while it winds down (flag kept, beat refreshed)', async () => {
    const handle = (await acquire('song-1', 'Song One'))!;
    handle.start(vi.fn());
    await requestAbort();
    await vi.advanceTimersByTimeAsync(2_000);
    const lock = await readLock();
    expect(lock).toMatchObject({ id: 'song-1', title: 'Song One', tab: TAB_ID, abort: true });
    expect(Date.now() - lock!.beat).toBeLessThanOrEqual(2_000);
  });

  it('a released owner cannot be aborted any more: the lock is gone', async () => {
    const onAbort = vi.fn();
    const handle = (await acquire())!;
    handle.start(onAbort);
    await handle.release();
    await requestAbort();
    expect(await getRaw(KEY)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('after the owner released, a new tab can take the lock without inheriting the flag', async () => {
    const handle = (await acquire('song-1'))!;
    handle.start(vi.fn());
    await requestAbort();
    await handle.release();
    const next = await acquire('song-2', 'Two');
    expect(next).not.toBeNull();
    expect(await readLock()).toEqual({ id: 'song-2', title: 'Two', tab: TAB_ID, beat: next!.lock.beat });
    expect(await readLock()).not.toHaveProperty('abort');
  });
});
