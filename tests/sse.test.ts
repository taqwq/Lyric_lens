import './setup';

import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/llm/sse';
import { ThinkFilter } from '../src/llm/openai';

function parseChunks(chunks: string[]): string[] {
  const p = new SseParser();
  const out: string[] = [];
  for (const c of chunks) out.push(...p.feed(c));
  out.push(...p.flush());
  return out;
}

describe('SseParser', () => {
  const body = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';

  it('returns one payload per event', () => {
    expect(parseChunks([body])).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('is independent of chunk boundaries (every split, and one char at a time)', () => {
    const whole = parseChunks([body]);
    for (let i = 0; i <= body.length; i += 1) {
      expect(parseChunks([body.slice(0, i), body.slice(i)])).toEqual(whole);
    }
    expect(parseChunks(Array.from(body))).toEqual(whole);
  });

  it('does not emit an event until its blank line arrives', () => {
    const p = new SseParser();
    expect(p.feed('data: hel')).toEqual([]);
    expect(p.feed('lo\n')).toEqual([]);
    expect(p.feed('\n')).toEqual(['hello']);
  });

  it('handles CRLF line endings, including a CR/LF pair split across chunks', () => {
    const crlf = body.replace(/\n/g, '\r\n');
    expect(parseChunks([crlf])).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
    expect(parseChunks(Array.from(crlf))).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
    expect(parseChunks(['data: x\r', '\n\r', '\n'])).toEqual(['x']);
  });

  it('joins multi-line data with newlines', () => {
    expect(parseChunks(['data: a\ndata: b\n\n'])).toEqual(['a\nb']);
  });

  it('strips only a single space after the colon', () => {
    expect(parseChunks(['data:x\n\n', 'data: y\n\n', 'data:  z\n\n'])).toEqual(['x', 'y', ' z']);
  });

  it('ignores comments and non-data fields', () => {
    expect(parseChunks([': ping\n\nevent: message\nid: 7\nretry: 100\ndata: ok\n\n'])).toEqual(['ok']);
  });

  it('does not emit empty events', () => {
    expect(parseChunks(['\n\n\n', 'event: x\n\n'])).toEqual([]);
  });

  it('flush() emits a trailing event that was never terminated by a blank line', () => {
    const p = new SseParser();
    expect(p.feed('data: a\n\ndata: tail\n')).toEqual(['a']);
    expect(p.flush()).toEqual(['tail']);
    expect(p.flush()).toEqual([]);
  });

  it('flush() also completes a last line that has no newline at all', () => {
    const p = new SseParser();
    expect(p.feed('data: tail')).toEqual([]);
    expect(p.flush()).toEqual(['tail']);
  });

  it('keeps multi-byte text intact', () => {
    expect(parseChunks(['data: {"t":"こん', 'にちは"}\n\n'])).toEqual(['{"t":"こんにちは"}']);
  });
});

describe('ThinkFilter', () => {
  function run(chunks: string[]): string {
    const f = new ThinkFilter();
    return chunks.map((c) => f.feed(c)).join('');
  }

  it('passes text without tags through unchanged', () => {
    expect(run(['L1: こんにちは\n'])).toBe('L1: こんにちは\n');
  });

  it('removes a <think> block inside one chunk', () => {
    expect(run(['<think>reasoning</think>L1: あ\n'])).toBe('L1: あ\n');
    expect(run(['before <think>x</think> after'])).toBe('before  after');
  });

  it('removes a block split across chunks, including inside the tags themselves', () => {
    expect(run(['<thi', 'nk>secret', ' stuff</th', 'ink>L1: あ\n'])).toBe('L1: あ\n');
    expect(run(['Hello <thi', 'nk>secret</th', 'ink> world'])).toBe('Hello  world');
  });

  it('gives the same output when fed one character at a time', () => {
    const text = 'L1: a\n<think>hmm\nmore</think>L2: b\n<think></think>L3: c\n';
    expect(run(Array.from(text))).toBe('L1: a\nL2: b\nL3: c\n');
    expect(run([text])).toBe('L1: a\nL2: b\nL3: c\n');
  });

  it('releases a false partial tag once the next chunk shows it is ordinary text', () => {
    const f = new ThinkFilter();
    expect(f.feed('a <')).toBe('a ');
    expect(f.feed('b')).toBe('<b');
    expect(run(['x <thin', 'g>'])).toBe('x <thing>');
  });

  it('hides everything after an unclosed <think>', () => {
    const f = new ThinkFilter();
    expect(f.feed('ok <think>never closed')).toBe('ok ');
    expect(f.feed(' still hidden')).toBe('');
  });

  it('handles several blocks and text between them', () => {
    expect(run(['<think>a</think>X<think>b</think>Y<think>c</think>Z'])).toBe('XYZ');
  });
});
