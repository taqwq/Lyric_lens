import './setup';

import { describe, expect, it } from 'vitest';
import { LLMError, classifyHttpError, isAbort, retryAfterMs } from '../src/llm/errors';

const googleError = (code: number, status: string, message: string, details?: unknown) =>
  JSON.stringify({ error: { code, status, message, ...(details ? { details } : {}) } });

describe('classifyHttpError', () => {
  it('maps 401/403 and key messages to auth', () => {
    expect(classifyHttpError(401, googleError(401, 'UNAUTHENTICATED', 'bad')).kind).toBe('auth');
    expect(classifyHttpError(403, '').kind).toBe('auth');
    expect(classifyHttpError(400, googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.')).kind).toBe('auth');
  });

  it('separates per-minute rate limits from daily quota', () => {
    const rate = classifyHttpError(429, googleError(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).'));
    expect(rate.kind).toBe('rate');
    const daily = classifyHttpError(429, googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota', [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
    ]));
    expect(daily.kind).toBe('quota');
    expect(classifyHttpError(429, JSON.stringify({ error: { message: 'insufficient_quota', code: 'insufficient_quota' } })).kind).toBe('quota');
  });

  it('maps 404 / 408 / 5xx / 400', () => {
    expect(classifyHttpError(404, googleError(404, 'NOT_FOUND', 'model is not found')).kind).toBe('not-found');
    expect(classifyHttpError(408, '').kind).toBe('timeout');
    expect(classifyHttpError(503, googleError(503, 'UNAVAILABLE', 'The model is overloaded.')).kind).toBe('overloaded');
    expect(classifyHttpError(500, 'oops').kind).toBe('overloaded');
    expect(classifyHttpError(400, googleError(400, 'INVALID_ARGUMENT', 'bad field')).kind).toBe('bad-request');
    expect(classifyHttpError(418, 'teapot').kind).toBe('unknown');
  });

  it('keeps status, message, and truncated detail; accepts array bodies', () => {
    const e = classifyHttpError(503, `[${googleError(503, 'UNAVAILABLE', 'high demand')}]`);
    expect(e).toBeInstanceOf(LLMError);
    expect(e.status).toBe(503);
    expect(e.message).toBe('high demand');
    expect(classifyHttpError(500, 'x'.repeat(10_000)).detail).toHaveLength(4000);
  });

  it('reads the retry delay', () => {
    const e = classifyHttpError(429, googleError(429, 'RESOURCE_EXHAUSTED', 'slow down', [{ '@type': 'RetryInfo', retryDelay: '12.3s' }]));
    expect(e.kind).toBe('rate');
    expect(e.retryAfterMs).toBe(12_300);
  });
});

describe('retryAfterMs', () => {
  it('parses Google RetryInfo, Retry-After seconds, and "retry in Ns" messages', () => {
    expect(retryAfterMs({ error: { details: [{ retryDelay: '2s' }] } })).toBe(2000);
    expect(retryAfterMs(null, 'content-type: x\nRetry-After: 7')).toBe(7000);
    expect(retryAfterMs({ error: { message: 'Please retry in 1.5s.' } })).toBe(1500);
    expect(retryAfterMs({}, '')).toBe(0);
  });
});

describe('isAbort', () => {
  it('is true only for aborted LLMErrors', () => {
    expect(isAbort(new LLMError('aborted', 'x'))).toBe(true);
    expect(isAbort(new LLMError('network', 'x'))).toBe(false);
    expect(isAbort(new Error('x'))).toBe(false);
  });
});
