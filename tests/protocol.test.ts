import './setup';

import { describe, expect, it } from 'vitest';
import { ProtocolParser, parseProtocolLine, type ProtocolEvent } from '../src/core/protocol';

function parseAll(text: string): ProtocolEvent[] {
  const p = new ProtocolParser();
  return [...p.feed(text), ...p.flush()];
}

describe('parseProtocolLine: translation lines', () => {
  it('parses `L12: 訳`', () => {
    expect(parseProtocolLine('L12: 訳')).toEqual({ type: 'line', uid: 12, ja: '訳' });
  });

  it('accepts the full-width colon and lowercase / spaced ids', () => {
    expect(parseProtocolLine('L3：こんにちは')).toEqual({ type: 'line', uid: 3, ja: 'こんにちは' });
    expect(parseProtocolLine('l 7 : ok')).toEqual({ type: 'line', uid: 7, ja: 'ok' });
  });

  it('strips leading bullets', () => {
    for (const bullet of ['- ', '* ', '• ']) {
      expect(parseProtocolLine(`${bullet}L1: 訳`)).toEqual({ type: 'line', uid: 1, ja: '訳' });
    }
  });

  it('strips **bold** wrappers around the whole line or just the label', () => {
    expect(parseProtocolLine('**L1: 訳**')).toEqual({ type: 'line', uid: 1, ja: '訳' });
    expect(parseProtocolLine('**L1:** 訳')).toEqual({ type: 'line', uid: 1, ja: '訳' });
    expect(parseProtocolLine('- **L2:** 訳')).toEqual({ type: 'line', uid: 2, ja: '訳' });
  });

  it('strips wrapping straight and curly quotes, but keeps inner quotes', () => {
    expect(parseProtocolLine('L1: "訳だよ"')).toEqual({ type: 'line', uid: 1, ja: '訳だよ' });
    expect(parseProtocolLine('L1: “訳だよ”')).toEqual({ type: 'line', uid: 1, ja: '訳だよ' });
    expect(parseProtocolLine('L1: 彼は"やめろ"と言った')).toEqual({ type: 'line', uid: 1, ja: '彼は"やめろ"と言った' });
  });

  it('ignores an empty translation, prose, and ids without digits', () => {
    expect(parseProtocolLine('L1:')).toBeNull();
    expect(parseProtocolLine('L1:   ')).toBeNull();
    expect(parseProtocolLine('Lyrics: foo')).toBeNull();
    expect(parseProtocolLine('Here is the translation:')).toBeNull();
    expect(parseProtocolLine('')).toBeNull();
  });

  it('ignores code fences', () => {
    expect(parseProtocolLine('```')).toBeNull();
    expect(parseProtocolLine('```text')).toBeNull();
    expect(parseAll('```\nL1: あ\n```\n')).toEqual([{ type: 'line', uid: 1, ja: 'あ' }]);
  });

  it('tolerates CRLF line endings', () => {
    expect(parseAll('L1: あ\r\nL2: い\r\n')).toEqual([
      { type: 'line', uid: 1, ja: 'あ' },
      { type: 'line', uid: 2, ja: 'い' },
    ]);
  });
});

describe('parseProtocolLine: notes', () => {
  it('parses `N3: slang | phrase | 説明`', () => {
    expect(parseProtocolLine('N3: slang | phrase | 説明')).toEqual({
      type: 'note', uid: 3, kind: 'slang', span: 'phrase', text: '説明', unsure: false,
    });
  });

  it('marks `N3?:` (and the full-width form) as unsure', () => {
    expect(parseProtocolLine('N3?: reference | Compton | 推測を含む')).toMatchObject({ type: 'note', uid: 3, kind: 'reference', unsure: true });
    expect(parseProtocolLine('N3？：reference｜Compton｜推測を含む')).toMatchObject({ type: 'note', uid: 3, kind: 'reference', span: 'Compton', unsure: true });
  });

  it('resolves kind aliases', () => {
    const kind = (k: string) => (parseProtocolLine(`N1: ${k} | x | y`) as { kind: string } | null)?.kind;
    expect(kind('pun')).toBe('wordplay');
    expect(kind('double-entendre')).toBe('wordplay');
    expect(kind('スラング')).toBe('slang');
    expect(kind('AAVE')).toBe('slang');
    expect(kind('Slang')).toBe('slang');
    expect(kind('ref')).toBe('reference');
    expect(kind('背景')).toBe('reference');
    expect(kind('expression')).toBe('idiom');
    expect(kind('慣用句')).toBe('idiom');
    expect(kind('ambiguous')).toBe('ambiguity');
    expect(kind('idiom')).toBe('idiom');
  });

  it('strips quotes / corner brackets around the span', () => {
    expect(parseProtocolLine('N1: slang | "gas" | 説明')).toMatchObject({ span: 'gas' });
    expect(parseProtocolLine('N1: slang | 「gas」 | 説明')).toMatchObject({ span: 'gas' });
  });

  it('keeps extra pipes inside the explanation', () => {
    expect(parseProtocolLine('N1: slang | gas | A | B')).toMatchObject({ span: 'gas', text: 'A | B' });
  });

  it('rejects malformed notes', () => {
    expect(parseProtocolLine('N3: slang | phrase')).toBeNull(); // no explanation
    expect(parseProtocolLine('N3: slang')).toBeNull();
    expect(parseProtocolLine('N3: nonsense | phrase | 説明')).toBeNull(); // unknown kind
    expect(parseProtocolLine('N3: slang |  | 説明')).toBeNull(); // empty span
    expect(parseProtocolLine('N3: slang | phrase | ')).toBeNull(); // empty text
    expect(parseProtocolLine('N3:')).toBeNull();
  });
});

describe('parseProtocolLine: @about / @voice', () => {
  it('parses both, with or without @ and the full-width colon', () => {
    expect(parseProtocolLine('@about: 曲の狙い')).toEqual({ type: 'about', text: '曲の狙い' });
    expect(parseProtocolLine('@voice: 語り手')).toEqual({ type: 'voice', text: '語り手' });
    expect(parseProtocolLine('@ABOUT：全角')).toEqual({ type: 'about', text: '全角' });
    expect(parseProtocolLine('voice: no at sign')).toEqual({ type: 'voice', text: 'no at sign' });
  });

  it('ignores empty context lines', () => {
    expect(parseProtocolLine('@about:')).toBeNull();
    expect(parseProtocolLine('@voice:   ')).toBeNull();
  });
});

describe('ProtocolParser', () => {
  const stream = [
    '@about: この曲は自慢の歌',
    '@voice: 俺が聴き手に語る',
    'L1: 一行目',
    'N1: slang | gas | 最高という意味',
    '- L2: 二行目',
    'N2?: reference | Compton | 推測',
    '**L3:** "三行目"',
    '```',
    'L4：四行目',
  ].join('\n');

  it('emits events only for completed lines, then flush() returns the last newline-less one', () => {
    const p = new ProtocolParser();
    const events = p.feed(stream);
    expect(events.map((e) => e.type)).toEqual(['about', 'voice', 'line', 'note', 'line', 'note', 'line']);
    expect(p.feed('')).toEqual([]);
    expect(p.flush()).toEqual([{ type: 'line', uid: 4, ja: '四行目' }]);
    expect(p.flush()).toEqual([]); // buffer was consumed
  });

  it('does not emit a half-written line before its newline arrives', () => {
    const p = new ProtocolParser();
    expect(p.feed('L1: 途')).toEqual([]);
    expect(p.feed('中まで')).toEqual([]);
    expect(p.feed('\n')).toEqual([{ type: 'line', uid: 1, ja: '途中まで' }]);
  });

  it('gives the same events however the text is chunked', () => {
    const whole = parseAll(stream);
    expect(whole).toHaveLength(8);

    // one character at a time
    const p = new ProtocolParser();
    const perChar: ProtocolEvent[] = [];
    for (const ch of stream) perChar.push(...p.feed(ch));
    perChar.push(...p.flush());
    expect(perChar).toEqual(whole);

    // every possible two-way split
    for (let i = 0; i <= stream.length; i += 1) {
      const q = new ProtocolParser();
      const evs = [...q.feed(stream.slice(0, i)), ...q.feed(stream.slice(i)), ...q.flush()];
      expect(evs).toEqual(whole);
    }
  });

  it('flush() on an empty or blank buffer returns nothing', () => {
    expect(new ProtocolParser().flush()).toEqual([]);
    const p = new ProtocolParser();
    p.feed('   ');
    expect(p.flush()).toEqual([]);
  });
});
