import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMError } from '../src/llm/errors';
import { streamRequest } from '../src/platform/http';

/** A fetch whose headers arrive at once and whose body delivers `chunks` (at ms, text) and then
 *  stays open until the request is aborted: a model that is thinking, or stuck. */
function openStream(chunks: Array<[number, string]> = []) {
  return vi.fn((_url: string, init: { signal: AbortSignal }) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const [at, text] of chunks) setTimeout(() => controller.enqueue(encoder.encode(text)), at);
        init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return Promise.resolve({ status: 200, headers: new Headers(), body });
  });
}

function watch(promise: Promise<unknown>) {
  const seen: { settled: boolean; error?: unknown } = { settled: false };
  promise.then(() => { seen.settled = true; }, (error: unknown) => { seen.settled = true; seen.error = error; });
  return seen;
}

describe('streamRequest: watchdog (fetch transport)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('measures the first byte from the start of the request to the first chunk of the body, not to the headers', async () => {
    vi.stubGlobal('fetch', openStream());
    const seen = watch(streamRequest({ url: 'https://api.example.test', firstByteTimeoutMs: 30_000, idleTimeoutMs: 90_000 }));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(seen.settled).toBe(false); // the headers are long here, the body is not
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.settled).toBe(true);
    expect(seen.error).toBeInstanceOf(LLMError);
    expect((seen.error as LLMError).kind).toBe('timeout'); // the chain moves on to the next model on this kind
  });

  it('switches to the idle timeout once the first chunk has arrived', async () => {
    vi.stubGlobal('fetch', openStream([[10_000, 'data: {}\n\n']]));
    const chunks: string[] = [];
    const seen = watch(streamRequest({ url: 'https://api.example.test', firstByteTimeoutMs: 30_000, idleTimeoutMs: 60_000, onText: (c) => chunks.push(c) }));
    await vi.advanceTimersByTimeAsync(30_001);
    expect(chunks).toEqual(['data: {}\n\n']);
    expect(seen.settled).toBe(false); // the first-byte deadline passed after the chunk: no longer applies
    await vi.advanceTimersByTimeAsync(39_998); // 69_999 ms: one before 10 s + the 60 s idle timeout
    expect(seen.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.settled).toBe(true);
    expect((seen.error as LLMError).kind).toBe('timeout');
  });

  it('applies the idle timeout even when it is shorter than the first-byte timeout', async () => {
    vi.stubGlobal('fetch', openStream([[5_000, 'data: {}\n\n']]));
    const seen = watch(streamRequest({ url: 'https://api.example.test', firstByteTimeoutMs: 30_000, idleTimeoutMs: 20_000 }));
    await vi.advanceTimersByTimeAsync(24_999);
    expect(seen.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.settled).toBe(true);
    expect((seen.error as LLMError).kind).toBe('timeout');
  });

  it('uses the idle timeout for the first byte when no first-byte timeout is given', async () => {
    vi.stubGlobal('fetch', openStream());
    const seen = watch(streamRequest({ url: 'https://api.example.test', idleTimeoutMs: 20_000 }));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(seen.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((seen.error as LLMError).kind).toBe('timeout');
  });
});
