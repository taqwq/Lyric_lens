import './setup';

import { describe, expect, it } from 'vitest';
import { ProtocolParser, parseRecord, type ProtocolEvent } from '../src/core/protocol';

function parseAll(text: string): ProtocolEvent[] {
  const p = new ProtocolParser();
  return [...p.feed(text), ...p.flush()];
}

const json = (value: unknown) => JSON.stringify(value);
const lineRec = (extra: Record<string, unknown> = {}) => json({ t: 'line', id: 'L1', ja: '訳', ...extra });

describe('parseRecord: line records', () => {
  it('parses a full line record with head and notes', () => {
    const ev = parseRecord(json({
      t: 'line', id: 'L12', head: 'Brought the heat', ja: '通りの熱気を持ってきた',
      notes: [{ q: 'heat', k: 'slang', x: '勢い・注目のこと', c: false, g: '123' }],
    }));
    expect(ev).toEqual({
      type: 'line', uid: 12, head: 'Brought the heat', ja: '通りの熱気を持ってきた',
      notes: [{ phrase: 'heat', kind: 'slang', text: '勢い・注目のこと', conjecture: false, genius: '123' }],
    });
  });

  it('defaults to no notes and no head', () => {
    const ev = parseRecord(lineRec());
    expect(ev).toEqual({ type: 'line', uid: 1, ja: '訳', notes: [] });
    expect(ev).not.toHaveProperty('head');
  });

  it('accepts the id as "L12", "12", 12, and lowercase / spaced forms', () => {
    const uid = (id: unknown) => (parseRecord(json({ t: 'line', id, ja: '訳' })) as { uid: number } | null)?.uid;
    expect(uid('L12')).toBe(12);
    expect(uid('12')).toBe(12);
    expect(uid(12)).toBe(12);
    expect(uid('l12')).toBe(12);
    expect(uid(' L 12 ')).toBe(12);
  });

  it('rejects an id that is not a short number', () => {
    for (const id of ['Lx', '', 'L', null, 'L12345', 'line 3', [3], { n: 3 }]) {
      expect(parseRecord(json({ t: 'line', id, ja: '訳' }))).toBeNull();
    }
    expect(parseRecord(json({ t: 'line', ja: '訳' }))).toBeNull();
  });

  it('rejects an empty or missing translation', () => {
    expect(parseRecord(json({ t: 'line', id: 'L1', ja: '' }))).toBeNull();
    expect(parseRecord(json({ t: 'line', id: 'L1', ja: '   ' }))).toBeNull();
    expect(parseRecord(json({ t: 'line', id: 'L1' }))).toBeNull();
    expect(parseRecord(json({ t: 'line', id: 'L1', ja: null }))).toBeNull();
  });

  it('treats a record with id and ja but no t as a line, and accepts "type" for "t"', () => {
    expect(parseRecord(json({ id: 'L4', ja: '四' }))).toEqual({ type: 'line', uid: 4, ja: '四', notes: [] });
    expect(parseRecord(json({ type: 'line', id: 'L4', ja: '四' }))).toEqual({ type: 'line', uid: 4, ja: '四', notes: [] });
    expect(parseRecord(json({ t: 'LINE', id: 'L4', ja: '四' }))).toMatchObject({ type: 'line', uid: 4 });
  });

  it('trims the translation and strips one pair of wrapping quotes, keeping inner quotes', () => {
    const ja = (value: string) => (parseRecord(json({ t: 'line', id: 'L1', ja: value })) as { ja: string } | null)?.ja;
    expect(ja('  訳だよ  ')).toBe('訳だよ');
    expect(ja('"訳だよ"')).toBe('訳だよ');
    expect(ja('“訳だよ”')).toBe('訳だよ');
    expect(ja('「訳だよ」')).toBe('訳だよ');
    expect(ja('彼は"やめろ"と言った')).toBe('彼は"やめろ"と言った');
  });

  // stripWrappingQuotes() only checks that the first character is *some* opening quote and the
  // last is *some* closing quote, not that they are a pair: a translation made of two quoted
  // phrases loses the outer brackets and is left unbalanced (src/core/protocol.ts:48-52).
  it('does not strip brackets that are not one wrapping pair', () => {
    const ev = parseRecord(json({ t: 'line', id: 'L1', ja: '「待て」と「行け」' }));
    expect(ev).toMatchObject({ ja: '「待て」と「行け」' });
  });

  it('ignores unknown extra fields', () => {
    expect(parseRecord(lineRec({ foo: 1, bar: { baz: [] } }))).toEqual({ type: 'line', uid: 1, ja: '訳', notes: [] });
  });
});

describe('parseRecord: notes', () => {
  const noteOf = (note: Record<string, unknown>) => {
    const ev = parseRecord(lineRec({ notes: [note] })) as { notes: unknown[] } | null;
    return ev?.notes[0];
  };

  it('maps q/k/x/c/g to phrase/kind/text/conjecture/genius', () => {
    expect(noteOf({ q: 'gas', k: 'slang', x: '最高という意味', c: true, g: '42' })).toEqual({
      phrase: 'gas', kind: 'slang', text: '最高という意味', conjecture: true, genius: '42',
    });
  });

  it('accepts c as true or "true", and treats everything else as not conjecture', () => {
    const c = (value: unknown) => (noteOf({ q: 'a', k: 'slang', x: 'b', c: value }) as { conjecture: boolean }).conjecture;
    expect(c(true)).toBe(true);
    expect(c('true')).toBe(true);
    expect(c(false)).toBe(false);
    expect(c('false')).toBe(false);
    expect(c(undefined)).toBe(false);
    expect(c(0)).toBe(false);
    expect(c('')).toBe(false);
  });

  it('omits genius when g is missing or blank, and stringifies a numeric g', () => {
    expect(noteOf({ q: 'a', k: 'slang', x: 'b' })).not.toHaveProperty('genius');
    expect(noteOf({ q: 'a', k: 'slang', x: 'b', g: '  ' })).not.toHaveProperty('genius');
    expect(noteOf({ q: 'a', k: 'slang', x: 'b', g: 123 })).toMatchObject({ genius: '123' });
  });

  it('resolves kind aliases, ignoring case', () => {
    const kind = (k: string) => (noteOf({ q: 'a', k, x: 'b' }) as { kind: string } | undefined)?.kind;
    expect(kind('pun')).toBe('wordplay');
    expect(kind('double-entendre')).toBe('wordplay');
    expect(kind('double_entendre')).toBe('wordplay');
    expect(kind('掛詞')).toBe('wordplay');
    expect(kind('ambiguity')).toBe('ambiguous');
    expect(kind('Ambiguity')).toBe('ambiguous');
    expect(kind('二通りに読める')).toBe('ambiguous');
    expect(kind('スラング')).toBe('slang');
    expect(kind('AAVE')).toBe('slang');
    expect(kind('Slang')).toBe('slang');
    expect(kind('ref')).toBe('reference');
    expect(kind('allusion')).toBe('reference');
    expect(kind('引用')).toBe('reference');
    expect(kind('expression')).toBe('idiom');
    expect(kind('慣用句')).toBe('idiom');
    for (const k of ['slang', 'wordplay', 'reference', 'idiom', 'ambiguous']) expect(kind(k)).toBe(k);
  });

  it('accepts a longer spelling that starts with a known kind', () => {
    const kind = (k: string) => (noteOf({ q: 'a', k, x: 'b' }) as { kind: string } | undefined)?.kind;
    expect(kind('slang term')).toBe('slang');
    expect(kind('idioms')).toBe('idiom');
  });

  it('accepts the long field names kind / phrase / text / conjecture / genius', () => {
    expect(noteOf({ kind: 'idiom', phrase: 'break a leg', text: '成功を祈る決まり文句', conjecture: true, genius: 9 })).toEqual({
      phrase: 'break a leg', kind: 'idiom', text: '成功を祈る決まり文句', conjecture: true, genius: '9',
    });
  });

  it('strips quotes / corner brackets around the phrase', () => {
    expect(noteOf({ q: '"gas"', k: 'slang', x: 'b' })).toMatchObject({ phrase: 'gas' });
    expect(noteOf({ q: '「gas」', k: 'slang', x: 'b' })).toMatchObject({ phrase: 'gas' });
  });

  it('drops only the malformed notes and keeps the rest of the line', () => {
    const ev = parseRecord(lineRec({
      notes: [
        { q: 'good', k: 'slang', x: 'ok' },
        { q: 'bad kind', k: 'nonsense', x: 'x' },
        { q: '', k: 'slang', x: 'x' },
        { q: 'no text', k: 'slang', x: '' },
        { q: 'no kind', x: 'x' },
        null,
        'not an object',
        { q: 'second good', k: 'pun', x: 'ok too' },
      ],
    })) as { ja: string; notes: Array<{ phrase: string }> };
    expect(ev.ja).toBe('訳');
    expect(ev.notes.map((n) => n.phrase)).toEqual(['good', 'second good']);
  });

  it('treats a notes value that is not an array as no notes', () => {
    for (const notes of [null, 'slang', 3, { q: 'a', k: 'slang', x: 'b' }]) {
      expect(parseRecord(lineRec({ notes }))).toEqual({ type: 'line', uid: 1, ja: '訳', notes: [] });
    }
  });
});

describe('parseRecord: song record', () => {
  it('parses who, what, tone and motifs', () => {
    const ev = parseRecord(json({
      t: 'song', who: '俺が元恋人に', what: '強がりの裏の未練を見せる曲', tone: '自嘲まじりの強がり',
      motifs: [{ en: 'gas', ja: '最高' }, { en: 'ghost', ja: '亡霊' }],
    }));
    expect(ev).toEqual({
      type: 'song', who: '俺が元恋人に', what: '強がりの裏の未練を見せる曲', tone: '自嘲まじりの強がり',
      motifs: [{ en: 'gas', ja: '最高' }, { en: 'ghost', ja: '亡霊' }],
    });
  });

  it('omits tone and motifs when absent or empty', () => {
    const ev = parseRecord(json({ t: 'song', who: 'A', what: 'B', tone: ' ', motifs: [] }));
    expect(ev).toEqual({ type: 'song', who: 'A', what: 'B' });
    expect(ev).not.toHaveProperty('tone');
    expect(ev).not.toHaveProperty('motifs');
  });

  it('drops motifs missing either side, and ignores a motifs value that is not an array', () => {
    const ev = parseRecord(json({
      t: 'song', who: 'A', what: 'B',
      motifs: [{ en: 'gas', ja: '最高' }, { en: 'half' }, { ja: '半分' }, {}, null],
    }));
    expect(ev).toMatchObject({ motifs: [{ en: 'gas', ja: '最高' }] });
    expect(parseRecord(json({ t: 'song', who: 'A', what: 'B', motifs: 'gas' }))).toEqual({ type: 'song', who: 'A', what: 'B' });
  });

  it('accepts a record with only one of who / what, but not neither', () => {
    expect(parseRecord(json({ t: 'song', who: 'A' }))).toEqual({ type: 'song', who: 'A', what: '' });
    expect(parseRecord(json({ t: 'song', what: 'B' }))).toEqual({ type: 'song', who: '', what: 'B' });
    expect(parseRecord(json({ t: 'song' }))).toBeNull();
    expect(parseRecord(json({ t: 'song', who: ' ', what: '' }))).toBeNull();
  });
});

describe('parseRecord: end record', () => {
  it('parses {"t":"end"}', () => {
    expect(parseRecord('{"t":"end"}')).toEqual({ type: 'end' });
    expect(parseRecord('{ "t" : "END" }')).toEqual({ type: 'end' });
    expect(parseRecord('{"type":"end"}')).toEqual({ type: 'end' });
  });
});

describe('parseRecord: tolerance', () => {
  it('strips leading bullets', () => {
    for (const bullet of ['- ', '* ', '• ']) {
      expect(parseRecord(`${bullet}${lineRec()}`)).toMatchObject({ type: 'line', uid: 1, ja: '訳' });
    }
  });

  it('strips a trailing comma', () => {
    expect(parseRecord(`${lineRec()},`)).toMatchObject({ type: 'line', uid: 1 });
    expect(parseRecord(`${lineRec()} ,  `)).toMatchObject({ type: 'line', uid: 1 });
    expect(parseRecord('{"t":"end"},')).toEqual({ type: 'end' });
  });

  it('copes with surrounding whitespace, a CR, and prose around the object', () => {
    expect(parseRecord(`   ${lineRec()}   \r`)).toMatchObject({ type: 'line', uid: 1 });
    expect(parseRecord(`Here you go: ${lineRec()}`)).toMatchObject({ type: 'line', uid: 1 });
  });

  it('ignores code fences', () => {
    expect(parseRecord('```')).toBeNull();
    expect(parseRecord('```json')).toBeNull();
    expect(parseRecord('  ```jsonl')).toBeNull();
    expect(parseAll(`\`\`\`json\n${lineRec()}\n\`\`\`\n`)).toEqual([{ type: 'line', uid: 1, ja: '訳', notes: [] }]);
  });

  it('drops anything that is not a usable record', () => {
    expect(parseRecord('')).toBeNull();
    expect(parseRecord('   ')).toBeNull();
    expect(parseRecord('Here is the translation:')).toBeNull();
    expect(parseRecord('L1: 古い形式の行')).toBeNull();
    expect(parseRecord('{not json}')).toBeNull();
    expect(parseRecord('{"t":"line","id":"L1","ja":"途中で切')).toBeNull(); // cut mid-string
    expect(parseRecord('{"t":"line","id":"L1","ja":"訳"')).toBeNull(); // cut before the brace
    expect(parseRecord('}{')).toBeNull();
    expect(parseRecord('[1, 2, 3]')).toBeNull();
    expect(parseRecord(`[${lineRec()}, ${lineRec({ id: 'L2' })}]`)).toBeNull(); // arrays are not records
    expect(parseRecord('{"t":"mystery","id":"L1","ja":"x"}')).toBeNull();
    expect(parseRecord('{}')).toBeNull();
    expect(parseRecord('{"hello":"world"}')).toBeNull();
    expect(parseRecord('null')).toBeNull();
  });
});

describe('ProtocolParser', () => {
  const records = [
    json({ t: 'song', who: '俺が君に', what: '強がりの歌', tone: '強気', motifs: [{ en: 'gas', ja: '最高' }] }),
    json({ t: 'line', id: 'L1', head: 'I woke up', ja: '早起きした', notes: [] }),
    `- ${json({ t: 'line', id: '2', head: 'Brought the heat', ja: '熱気を持ってきた', notes: [{ q: 'heat', k: 'pun', x: '注目の意味', c: 'true' }] })},`,
    '```',
    'oops this is prose',
    json({ t: 'line', id: 3, ja: '絵文字 😀 つき' }),
    '{"t":"line","id":"L4","ja":"途中で壊れた',
    json({ t: 'line', id: 'L5', ja: '五' }),
    json({ t: 'end' }),
  ];
  const stream = records.join('\n');
  const expected: ProtocolEvent[] = [
    { type: 'song', who: '俺が君に', what: '強がりの歌', tone: '強気', motifs: [{ en: 'gas', ja: '最高' }] },
    { type: 'line', uid: 1, head: 'I woke up', ja: '早起きした', notes: [] },
    { type: 'line', uid: 2, head: 'Brought the heat', ja: '熱気を持ってきた', notes: [{ phrase: 'heat', kind: 'wordplay', text: '注目の意味', conjecture: true }] },
    { type: 'line', uid: 3, ja: '絵文字 😀 つき', notes: [] },
    { type: 'line', uid: 5, ja: '五', notes: [] },
    { type: 'end' },
  ];

  it('emits an event for each completed line, drops the malformed ones, and flush() returns the newline-less last', () => {
    const p = new ProtocolParser();
    const events = p.feed(stream);
    expect(events).toEqual(expected.slice(0, -1));
    expect(p.feed('')).toEqual([]);
    expect(p.flush()).toEqual([{ type: 'end' }]);
    expect(p.flush()).toEqual([]); // buffer was consumed
  });

  it('does not emit a half-written record before its newline arrives', () => {
    const p = new ProtocolParser();
    const full = lineRec({ ja: '途中まで' });
    expect(p.feed(full.slice(0, 20))).toEqual([]);
    expect(p.feed(full.slice(20, full.length - 1))).toEqual([]);
    expect(p.feed(full.slice(-1))).toEqual([]); // the closing brace alone is not enough
    expect(p.feed('\n')).toEqual([{ type: 'line', uid: 1, ja: '途中まで', notes: [] }]);
  });

  it('gives the same events however the text is chunked', () => {
    const whole = parseAll(stream);
    expect(whole).toEqual(expected);

    // one UTF-16 unit at a time (this also splits the emoji's surrogate pair)
    const perUnit = new ProtocolParser();
    const out: ProtocolEvent[] = [];
    for (let i = 0; i < stream.length; i += 1) out.push(...perUnit.feed(stream[i]!));
    out.push(...perUnit.flush());
    expect(out).toEqual(whole);

    // every possible two-way split
    for (let i = 0; i <= stream.length; i += 1) {
      const q = new ProtocolParser();
      const evs = [...q.feed(stream.slice(0, i)), ...q.feed(stream.slice(i)), ...q.flush()];
      expect(evs).toEqual(whole);
    }

    // chunk sizes 2..40
    for (let size = 2; size <= 40; size += 1) {
      const q = new ProtocolParser();
      const evs: ProtocolEvent[] = [];
      for (let i = 0; i < stream.length; i += size) evs.push(...q.feed(stream.slice(i, i + size)));
      evs.push(...q.flush());
      expect(evs).toEqual(whole);
    }
  });

  it('gives the same events with CRLF line endings and a trailing newline', () => {
    const crlf = `${records.join('\r\n')}\r\n`;
    expect(parseAll(crlf)).toEqual(expected);
    expect(parseAll(`${stream}\n`)).toEqual(expected);
  });

  it('flush() returns a complete final record that has no newline', () => {
    const p = new ProtocolParser();
    expect(p.feed(lineRec({ id: 'L7', ja: '最後の行' }))).toEqual([]);
    expect(p.flush()).toEqual([{ type: 'line', uid: 7, ja: '最後の行', notes: [] }]);
  });

  it('flush() drops a record that was cut off', () => {
    const p = new ProtocolParser();
    p.feed(`${lineRec({ id: 'L1' })}\n${lineRec({ id: 'L2', ja: '切れた行' }).slice(0, -6)}`);
    expect(p.flush()).toEqual([]);
  });

  it('flush() on an empty or blank buffer returns nothing', () => {
    expect(new ProtocolParser().flush()).toEqual([]);
    const p = new ProtocolParser();
    p.feed('   ');
    expect(p.flush()).toEqual([]);
  });

  it('keeps working after a malformed line', () => {
    const p = new ProtocolParser();
    expect(p.feed('{{{{\n')).toEqual([]);
    expect(p.feed(`${lineRec()}\n`)).toHaveLength(1);
  });
});
