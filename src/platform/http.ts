/*
 * Streaming HTTP for userscripts. Tries, in order:
 *   1. GM_xmlhttpRequest with responseType "stream" (Tampermonkey)
 *   2. GM_xmlhttpRequest / GM.xmlHttpRequest with progressive responseText (Violentmonkey…)
 *   3. fetch (dev harness, tests, managers without GM xhr)
 * Whatever the path, onText receives the body incrementally when the manager allows it,
 * or all at once at the end when it does not. Callers must not depend on chunking.
 */
import { LLMError } from '../llm/errors';

export interface StreamRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  onText?: (chunk: string) => void;
  signal?: AbortSignal;
  /** Abort when nothing arrives for this long (the first byte may take longer: thinking). */
  idleTimeoutMs?: number;
  firstByteTimeoutMs?: number;
}

export interface HttpResult {
  status: number;
  text: string;
  headers: string;
}

type GmXhr = (details: GMRequestDetails) => GMHandle | Promise<unknown>;

function pickGmXhr(): { fn: GmXhr; legacy: boolean } | null {
  try {
    if (typeof GM_xmlhttpRequest === 'function') return { fn: GM_xmlhttpRequest, legacy: true };
  } catch { /* not granted */ }
  try {
    if (typeof GM !== 'undefined' && typeof GM?.xmlHttpRequest === 'function') return { fn: GM.xmlHttpRequest, legacy: false };
  } catch { /* not granted */ }
  return null;
}

function handlerName(): string {
  try { return (typeof GM_info !== 'undefined' && GM_info?.scriptHandler) || ''; } catch { return ''; }
}

let forceFetch = false;
/** Tests and the dev harness route everything through fetch. */
export function useFetchTransport(value: boolean): void { forceFetch = value; }

/** Whether answers can arrive incrementally here. Tampermonkey (stream) and Violentmonkey
 *  (progressive responseText) do; others, such as iOS "Userscripts", deliver at the end. */
export function transportStreams(): boolean {
  if (forceFetch) return true;
  const gm = pickGmXhr();
  if (!gm) return true;
  return /tampermonkey|violentmonkey/i.test(handlerName());
}

export function streamRequest(req: StreamRequest): Promise<HttpResult> {
  const gm = forceFetch ? null : pickGmXhr();
  return gm ? viaGm(gm.fn, req) : viaFetch(req);
}

class Watchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gotData = false;
  constructor(private readonly req: StreamRequest, private readonly onFire: () => void) { this.arm(); }
  arm(): void {
    this.clear();
    const ms = this.gotData ? this.req.idleTimeoutMs : (this.req.firstByteTimeoutMs ?? this.req.idleTimeoutMs);
    if (ms) this.timer = setTimeout(this.onFire, ms);
  }
  data(): void { this.gotData = true; this.arm(); }
  clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

function viaGm(fn: GmXhr, req: StreamRequest): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    let delivered = 0; // chars of responseText already passed to onText
    let streamed = ''; // text read from a ReadableStream
    let usingStream = false;
    let streamDone: Promise<void> = Promise.resolve();
    let settled = false;
    let handle: GMHandle | null = null;
    const decoder = new TextDecoder();

    const fail = (error: LLMError) => {
      if (settled) return;
      settled = true;
      watchdog.clear();
      try { handle?.abort?.(); } catch { /* ignore */ }
      reject(error);
    };
    const watchdog = new Watchdog(req, () => fail(new LLMError('timeout', '応答が途切れました。')));
    const onAbort = () => fail(new LLMError('aborted', '中止しました。'));
    if (req.signal?.aborted) { onAbort(); return; }
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const push = (chunk: string) => {
      if (!chunk || settled) return;
      watchdog.data();
      req.onText?.(chunk);
    };
    const pushProgress = (r: GMResponse) => {
      if (usingStream) return;
      const text = typeof r.responseText === 'string' ? r.responseText : '';
      if (text.length > delivered) {
        const chunk = text.slice(delivered);
        delivered = text.length;
        push(chunk);
      }
    };

    const wantsStream = handlerName() === 'Tampermonkey';
    // Managers that deliver the body only at onload give no sign of life while the model
    // works; there, only a generous overall timeout applies (see transportStreams()).
    if (!transportStreams()) watchdog.clear();
    const details: GMRequestDetails = {
      method: req.method ?? 'POST',
      url: req.url,
      headers: req.headers,
      data: req.body,
      timeout: transportStreams() ? undefined : 300_000,
      responseType: wantsStream ? 'stream' : 'text',
      onloadstart: (r) => {
        const body = r?.response as ReadableStream<Uint8Array> | undefined;
        if (!body || typeof (body as ReadableStream).getReader !== 'function') return;
        usingStream = true;
        const reader = body.getReader();
        streamDone = (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              streamed += chunk;
              push(chunk);
            }
            const tail = decoder.decode();
            if (tail) { streamed += tail; push(tail); }
          } catch {
            /* reader errors surface through onerror/onabort */
          }
        })();
      },
      onprogress: (r) => {
        pushProgress(r);
        // Bytes arrived even if responseText did not grow yet: the request is alive.
        if (!settled && transportStreams()) watchdog.data();
      },
      onload: (r) => {
        void streamDone.then(() => {
          if (settled) return;
          pushProgress(r);
          settled = true;
          watchdog.clear();
          req.signal?.removeEventListener('abort', onAbort);
          const text = usingStream ? streamed : (typeof r.responseText === 'string' ? r.responseText : '');
          resolve({ status: r.status, text, headers: r.responseHeaders ?? '' });
        });
      },
      // Keep the manager's own reason (e.g. a refused @connect) for the error details.
      onerror: (r) => fail(new LLMError('network', 'ネットワークに接続できませんでした。', { detail: String((r as GMResponse & { error?: string })?.error || r?.statusText || '') })),
      ontimeout: () => fail(new LLMError('timeout', '応答がタイムアウトしました。')),
      onabort: () => fail(new LLMError('aborted', '中止しました。')),
    };
    const ret = fn(details);
    if (ret && typeof (ret as GMHandle).abort === 'function') handle = ret as GMHandle;
  });
}

async function viaFetch(req: StreamRequest): Promise<HttpResult> {
  const controller = new AbortController();
  let reason: LLMError | null = null;
  const stop = (error: LLMError) => { reason ??= error; controller.abort(); };
  const watchdog = new Watchdog(req, () => stop(new LLMError('timeout', '応答が途切れました。')));
  const onAbort = () => stop(new LLMError('aborted', '中止しました。'));
  if (req.signal?.aborted) throw new LLMError('aborted', '中止しました。');
  req.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(req.url, { method: req.method ?? 'POST', headers: req.headers, body: req.body, signal: controller.signal });
    const headers = Array.from(res.headers.entries()).map(([k, v]) => `${k}: ${v}`).join('\n');
    let text = '';
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        text += chunk;
        watchdog.data();
        req.onText?.(chunk);
      }
      const tail = decoder.decode();
      if (tail) { text += tail; req.onText?.(tail); }
    } else {
      text = await res.text();
      req.onText?.(text);
    }
    return { status: res.status, text, headers };
  } catch (error) {
    if (reason) throw reason;
    if (error instanceof LLMError) throw error;
    throw new LLMError('network', 'ネットワークに接続できませんでした。', { detail: String(error) });
  } finally {
    watchdog.clear();
    req.signal?.removeEventListener('abort', onAbort);
  }
}
