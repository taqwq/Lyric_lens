export type LLMErrorKind =
  | 'auth' // key missing / invalid / not permitted
  | 'quota' // daily or plan quota exhausted: waiting seconds will not help
  | 'rate' // per-minute limit: waiting helps
  | 'overloaded' // 5xx / "high demand"
  | 'not-found' // model not available for this key
  | 'bad-request'
  | 'blocked' // safety / recitation stop
  | 'truncated' // output limit reached
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'empty'
  | 'unknown';

export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly status: number;
  readonly retryAfterMs: number;
  readonly detail: string;
  model = '';
  provider = '';

  constructor(kind: LLMErrorKind, message: string, opts: { status?: number; retryAfterMs?: number; detail?: string } = {}) {
    super(message);
    this.name = 'LLMError';
    this.kind = kind;
    this.status = opts.status ?? 0;
    this.retryAfterMs = opts.retryAfterMs ?? 0;
    this.detail = opts.detail ?? '';
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof LLMError && error.kind === 'aborted';
}

/** Parses "Retry-After" / Google RetryInfo / "retry in 12.3s" into milliseconds. */
export function retryAfterMs(body: unknown, rawHeaders = ''): number {
  const details = (body as { error?: { details?: Array<{ retryDelay?: string }> } })?.error?.details;
  for (const d of Array.isArray(details) ? details : []) {
    const m = typeof d?.retryDelay === 'string' ? /^([\d.]+)s$/.exec(d.retryDelay) : null;
    if (m) return Math.ceil(Number(m[1]) * 1000);
  }
  const header = /^retry-after:\s*(.+)$/im.exec(rawHeaders)?.[1]?.trim();
  if (header) {
    if (/^[\d.]+$/.test(header)) return Math.ceil(Number(header) * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const msg = String((body as { error?: { message?: string } })?.error?.message ?? '');
  const m = /retry in ([\d.]+)\s*s/i.exec(msg);
  return m ? Math.ceil(Number(m[1]) * 1000) : 0;
}

/** Maps an HTTP failure to an error kind. Shared by every provider. */
export function classifyHttpError(status: number, bodyText: string, rawHeaders = ''): LLMError {
  let body: unknown = null;
  try { body = JSON.parse(bodyText); } catch { /* not JSON */ }
  const apiError = (Array.isArray(body) ? body[0] : body) as { error?: { message?: string; status?: string; code?: string | number; details?: unknown } } | null;
  const message = String(apiError?.error?.message ?? (bodyText.slice(0, 300) || `HTTP ${status}`));
  const code = String(apiError?.error?.status ?? apiError?.error?.code ?? '');
  const everything = `${message} ${code} ${JSON.stringify(apiError?.error?.details ?? '')}`;
  const retry = retryAfterMs(apiError, rawHeaders);
  const opts = { status, retryAfterMs: retry, detail: bodyText.slice(0, 4000) };

  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid|invalid api key|PERMISSION_DENIED|unauthorized/i.test(everything)) {
    return new LLMError('auth', message, opts);
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(everything)) {
    const daily = /PerDay|per.day|daily|limit: 0\b|free_tier|FreeTier|insufficient_quota|credits/i.test(everything);
    return new LLMError(daily ? 'quota' : 'rate', message, opts);
  }
  if (status === 404 || /NOT_FOUND|model_not_found|does not exist|is not found/i.test(everything)) {
    return new LLMError('not-found', message, opts);
  }
  if (status === 408) return new LLMError('timeout', message, opts);
  if (status >= 500 || /UNAVAILABLE|overloaded|high demand/i.test(everything)) {
    return new LLMError('overloaded', message, opts);
  }
  if (status === 400 || status === 413 || status === 422) return new LLMError('bad-request', message, opts);
  return new LLMError('unknown', message, opts);
}
