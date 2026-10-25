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

/** A 429 body shaped like the ones the Gemini API returns on the free tier. */
function geminiQuotaBody(quotaId: string, retryDelay?: string): string {
  return JSON.stringify({
    error: {
      code: 429,
      message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n'
        + '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-2.5-flash\n'
        + 'Please retry in 41.5s.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.Help',
          links: [{ description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }],
        },
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId,
            quotaDimensions: { location: 'global', model: 'gemini-2.5-flash' },
            quotaValue: '5',
          }],
        },
        ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
      ],
    },
  });
}

describe('classifyHttpError: 429 per-minute versus per-day', () => {
  it('a real-shaped Gemini per-minute free-tier body is a rate limit, not the daily quota', () => {
    // The message and the metric both say "free_tier", whatever the window; the quota id names it.
    const e = classifyHttpError(429, geminiQuotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '41s'));
    expect(e.kind).toBe('rate');
    expect(e.retryAfterMs).toBe(41_000);
    expect(e.status).toBe(429);
  });

  it('a real-shaped Gemini per-day free-tier body is the daily quota', () => {
    const e = classifyHttpError(429, geminiQuotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '57083s'));
    expect(e.kind).toBe('quota');
    expect(e.retryAfterMs).toBe(57_083_000);
  });

  it('names the window before the tier: PerMinute wins over free_tier, PerDay wins over PerMinute', () => {
    expect(classifyHttpError(429, geminiQuotaBody('GenerateContentInputTokensPerMinutePerProjectPerModel-FreeTier')).kind).toBe('rate');
    expect(classifyHttpError(429, geminiQuotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier')).kind).toBe('quota');
    const both = JSON.parse(geminiQuotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')) as { error: { details: Array<{ violations?: unknown[] }> } };
    both.error.details[1]!.violations!.push({ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' });
    expect(classifyHttpError(429, JSON.stringify(both)).kind).toBe('quota');
  });

  it('a free-tier body that names no window at all is treated as the daily quota', () => {
    expect(classifyHttpError(429, geminiQuotaBody('GenerateRequestsFreeTier')).kind).toBe('quota');
    expect(classifyHttpError(429, googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for generate_content_free_tier_requests')).kind).toBe('quota');
  });

  it('a limit of zero is a quota, not something to wait out', () => {
    expect(classifyHttpError(429, googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded, limit: 0, model: gemini-2.5-pro')).kind).toBe('quota');
  });

  it('classifies other providers by the window their message names', () => {
    const body = (message: string) => JSON.stringify({ error: { message, type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' } });
    expect(classifyHttpError(429, body('Rate limit reached for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 6000')).kind).toBe('rate');
    expect(classifyHttpError(429, body('Rate limit reached for model `llama-3.3-70b-versatile` on tokens per day (TPD): Limit 100000')).kind).toBe('quota');
    expect(classifyHttpError(429, body('Rate limit reached on requests per day (RPD): Limit 1000')).kind).toBe('quota');
    expect(classifyHttpError(429, body('Rate limit exceeded: free-models-per-day')).kind).toBe('quota');
    expect(classifyHttpError(429, body('Rate limit exceeded: free-models-per-min')).kind).toBe('rate');
    expect(classifyHttpError(429, body('You exceeded your current quota: daily limit reached')).kind).toBe('quota');
    expect(classifyHttpError(429, 'Too Many Requests').kind).toBe('rate');
  });

  it('reads the wait from RetryInfo before the message, and from the message when there is no RetryInfo', () => {
    expect(classifyHttpError(429, geminiQuotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '41s')).retryAfterMs).toBe(41_000);
    expect(classifyHttpError(429, geminiQuotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')).retryAfterMs).toBe(41_500); // from "Please retry in 41.5s"
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
