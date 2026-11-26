/*
 * One in-flight request per song across tabs (docs/DESIGN.md §3, request guards): two
 * tabs never write the same song, while different songs translate at the same time.
 * The owner refreshes a heartbeat; a lock without a beat for 10 s is stale. Another tab
 * can ask the owner to stop by setting `abort`.
 */
import { getJSON, remove, setJSON } from '../platform/storage';

export interface Lock {
  /** Song identity being translated. */
  id: string;
  title: string;
  tab: string;
  beat: number;
  abort?: boolean;
}

const PREFIX = 'll3:lock:';
const keyOf = (id: string): string => PREFIX + id;
const STALE_MS = 10_000;
const BEAT_MS = 2_000;

export const TAB_ID = Math.random().toString(36).slice(2, 10);

/** The live lock on a song, if any tab holds one. */
export async function readLock(id: string): Promise<Lock | null> {
  const lock = await getJSON<Lock | null>(keyOf(id), null);
  if (!lock || Date.now() - lock.beat > STALE_MS) return null;
  return lock;
}

export class LockHandle {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly key: string;
  constructor(readonly lock: Lock) { this.key = keyOf(lock.id); }

  /** Keeps the lock alive; calls onAbort if another tab asks this one to stop. */
  start(onAbort: () => void): void {
    this.timer = setInterval(async () => {
      const current = await getJSON<Lock | null>(this.key, null);
      const ours = current?.tab === TAB_ID && current.id === this.lock.id;
      if (current && !ours) {
        // Our beat stopped long enough (frozen/throttled tab) for someone else to take the
        // lock. Never steal it back; the request already in flight just finishes.
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        return;
      }
      if (ours && current?.abort) onAbort();
      await setJSON(this.key, { ...this.lock, beat: Date.now(), ...(ours && current?.abort ? { abort: true } : {}) });
    }, BEAT_MS);
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const current = await getJSON<Lock | null>(this.key, null);
    if (current?.tab === TAB_ID && current.id === this.lock.id) await remove(this.key);
  }
}

/** Takes the lock for a song, or returns null if someone else holds it. */
export async function acquireLock(id: string, title: string): Promise<LockHandle | null> {
  const current = await readLock(id);
  if (current && current.tab !== TAB_ID) return null;
  const lock: Lock = { id, title, tab: TAB_ID, beat: Date.now() };
  await setJSON(keyOf(id), lock);
  // GM storage has no compare-and-swap: re-read to make sure no other tab won the race.
  await new Promise((r) => setTimeout(r, 80));
  const check = await getJSON<Lock | null>(keyOf(id), null);
  if (check?.tab !== TAB_ID || check.id !== id) return null;
  return new LockHandle(lock);
}

/** Asks whoever holds the song's lock to stop (the owner obeys within one heartbeat). */
export async function requestAbort(id: string): Promise<void> {
  const current = await readLock(id);
  if (current) await setJSON(keyOf(id), { ...current, abort: true });
}
