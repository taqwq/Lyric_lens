import './setup';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { availability, claudeKeyStatus, generateWithFallback } from '../src/llm/chain';
import { ClaudeProvider, classifyClaudeError } from '../src/llm/claude';
import type { HttpResult, StreamRequest } from '../src/platform/http';
import { streamRequest } from '../src/platform/http';
import { memoryStorage, setKV } from '../src/platform/storage';

vi.mock('../src/platform/http', () => ({ streamRequest: vi.fn() }));
const http = vi.mocked(streamRequest);

const CLAUDE_KEY = 'sk-ant-api03-exampleexample';
const GEMINI_KEY = 'AIzaSyExampleGeminiKey1234';

const ev = (data: unknown) => `event: x\ndata: ${JSON.stringify(data)}\n\n`;
const claudeOk = (text: string) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  + ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
const creditError = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } });
const geminiOk = (text: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })}\n\n`;

/** Every request URL, in order, and the Claude request bodies. */
let urls: string[] = [];
let claudeBodies: Array<Record<string, unknown>> = [];
let claudeReply: { status: number; body: string };

beforeEach(() => {
  setKV(memoryStorage());
  urls = [];
  claudeBodies = [];
  claudeReply = { status: 200, body: claudeOk('{"t":"end"}') };
  http.mockReset();
  http.mockImplementation(async (req: StreamRequest): Promise<HttpResult> => {
    urls.push(req.url);
    let reply: { status: number; body: string };
    if (req.url.includes('api.anthropic.com/v1/messages')) {
      claudeBodies.push(JSON.parse(req.body ?? '{}'));
      reply = claudeReply;
    } else if (req.url.includes('/v1beta/models?')) {
      reply = { status: 200, body: JSON.stringify({ models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] }) };
    } else {
      reply = { status: 200, body: geminiOk('gemini text') };
    }
    req.onText?.(reply.body);
    return { status: reply.status, text: reply.body, headers: '' };
  });
});

describe('classifyClaudeError', () => {
  it('reads a spent credit as quota (Anthropic refuses and charges nothing)', () => {
    expect(classifyClaudeError(400, creditError).kind).toBe('quota');
  });

  it('reads auth, rate and overload', () => {
    expect(classifyClaudeError(401, JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })).kind).toBe('auth');
    expect(classifyClaudeError(429, '{}', 'retry-after: 30').retryAfterMs).toBe(30_000);
    expect(classifyClaudeError(529, JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })).kind).toBe('overloaded');
  });
});

describe('ClaudeProvider.verify', () => {
  it('retries a silent stream in text mode and keeps text mode for translations', async () => {
    const base = http.getMockImplementation()!;
    const modes: Array<boolean | undefined> = [];
    http.mockImplementation(async (req: StreamRequest) => {
      modes.push(req.textMode);
      if (req.url.includes('/v1/models') && !req.textMode) {
        const { LLMError } = await import('../src/llm/errors');
        throw new LLMError('timeout', '応答がないため中断しました');
      }
      if (req.url.includes('/v1/models')) return { status: 200, text: '{"data":[]}', headers: '' };
      return base(req);
    });
    await new ClaudeProvider(CLAUDE_KEY).verify();
    await new ClaudeProvider(CLAUDE_KEY).generate({ system: 's', user: 'u', maxOutputTokens: 8000, onText: () => {} });
    expect(modes).toEqual([false, true, true]);
  });

  it('tries stream mode again a day after it failed, and keeps it when it answers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 27, 3, 0));
    try {
      const base = http.getMockImplementation()!;
      const calls: Array<[string, boolean | undefined]> = [];
      let streamWorks = false;
      http.mockImplementation(async (req: StreamRequest) => {
        calls.push([req.url.includes('/v1/models') ? 'models' : 'messages', req.textMode]);
        if (req.url.includes('/v1/models')) {
          if (!req.textMode && !streamWorks) {
            const { LLMError } = await import('../src/llm/errors');
            throw new LLMError('timeout', '返事がないため打ち切りました');
          }
          return { status: 200, text: '{"data":[]}', headers: '' };
        }
        return base(req);
      });
      const generate = () => new ClaudeProvider(CLAUDE_KEY).generate({ system: 's', user: 'u', maxOutputTokens: 8000, onText: () => {} });
      await new ClaudeProvider(CLAUDE_KEY).verify();
      await generate();
      // A day later stream mode still fails: text mode stays, checked again after another day.
      vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
      await generate();
      await generate();
      // Another day on, stream mode answers: translations stream again, with no further check.
      vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
      streamWorks = true;
      await generate();
      await generate();
      expect(calls).toEqual([
        ['models', false], ['models', true], ['messages', true],
        ['models', false], ['messages', true], ['messages', true],
        ['models', false], ['messages', false], ['messages', false],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks stream mode at once when an earlier version saved text mode', async () => {
    const { setJSON } = await import('../src/platform/storage');
    await setJSON('ll3:claude:text', true);
    const modes: Array<[string, boolean | undefined]> = [];
    const base = http.getMockImplementation()!;
    http.mockImplementation(async (req: StreamRequest) => {
      modes.push([req.url.includes('/v1/models') ? 'models' : 'messages', req.textMode]);
      return base(req);
    });
    await new ClaudeProvider(CLAUDE_KEY).generate({ system: 's', user: 'u', maxOutputTokens: 8000, onText: () => {} });
    expect(modes).toEqual([['models', false], ['messages', false]]);
  });
});

describe('ClaudeProvider.generate', () => {
  it('asks Opus 5.5 at medium effort and returns the streamed text', async () => {
    const chunks: string[] = [];
    const result = await new ClaudeProvider(CLAUDE_KEY).generate({ system: 's', user: 'u', maxOutputTokens: 8000, onText: (c) => { chunks.push(c); } });
    expect(result).toEqual({ finish: 'stop', finishDetail: 'end_turn', text: '{"t":"end"}' });
    expect(chunks.join('')).toBe('{"t":"end"}');
    expect(claudeBodies[0]).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'medium' }, stream: true, system: 's' });
    expect(claudeBodies[0]).not.toHaveProperty('temperature');
    expect(claudeBodies[0]).not.toHaveProperty('thinking');
  });
});

describe('generateWithFallback with a Claude key', () => {
  const request = { system: 's', user: 'u', maxOutputTokens: 8000, onText: () => true };

  it('uses Claude first and does not touch Gemini when Claude answers', async () => {
    const result = await generateWithFallback(GEMINI_KEY, request, { claudeKey: CLAUDE_KEY });
    expect(result.model).toBe('claude-opus-5-5');
    expect(urls.every((u) => u.includes('api.anthropic.com'))).toBe(true);
  });

  it('falls back to Gemini when the credit is spent, and skips Claude on the next call', async () => {
    claudeReply = { status: 400, body: creditError };
    const first = await generateWithFallback(GEMINI_KEY, request, { claudeKey: CLAUDE_KEY });
    expect(first.model).toBe('gemini-3.5-flash-lite');
    expect(await claudeKeyStatus(CLAUDE_KEY)).toMatchObject({ kind: 'resting' });

    urls = [];
    const second = await generateWithFallback(GEMINI_KEY, request, { claudeKey: CLAUDE_KEY });
    expect(second.model).toBe('gemini-3.5-flash-lite');
    expect(urls.some((u) => u.includes('api.anthropic.com'))).toBe(false);
  });

  it('counts a usable Claude key as a reason to send', async () => {
    expect(await availability(GEMINI_KEY, CLAUDE_KEY)).toEqual({ ok: true, until: 0 });
  });
});
