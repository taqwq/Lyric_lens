import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateWithFallback, nextPacificMidnight, type ChainResult } from '../src/llm/chain';
import { LLMError, type LLMErrorKind } from '../src/llm/errors';
import type { ProviderConfig } from '../src/llm/types';
import { RecordBuilder, contiguousPhrase, stopFromError, stripGlosses, translateSong, trimDefinition, widenParens } from '../src/core/pipeline';
import type { ProtocolEvent } from '../src/core/protocol';
import { buildSong, emptyRecord, missingLines } from '../src/core/song';
import type { Note, NoteKind, SongMeta, SongRecord, SongSource } from '../src/core/types';
import { locatePhrase } from '../src/genius/ranges';

// Only the network-facing generateWithFallback is replaced; the Pacific-midnight maths is the real one.
vi.mock('../src/llm/chain', async () => {
  const actual = await vi.importActual<typeof import('../src/llm/chain')>('../src/llm/chain');
  return { generateWithFallback: vi.fn(), nextPacificMidnight: actual.nextPacificMidnight };
});

const chain = vi.mocked(generateWithFallback);

type ChainRequest = Parameters<typeof generateWithFallback>[1];

/* ---------- a scripted model ---------- */

interface Script {
  /** What the model streams (JSONL). */
  text?: string;
  /** Exact pieces to stream instead of slicing `text` into `chunk` characters. */
  chunks?: string[];
  chunk?: number;
  finish?: ChainResult['finish'];
  /** The stream broke after the text. Like the real chain: if anything useful arrived (onText
   *  said so) the result carries `error` and the text is kept; otherwise the chain throws. */
  breaks?: LLMError;
  /** The chain itself throws after the text (aborted, or every model failed). */
  throws?: unknown;
  model?: string;
}

/** What onText returned for each chunk, one array per chain call. */
let returned: Array<Array<boolean | void>> = [];

/** Makes the next chain calls stream the given scripts through request.onText. */
function script(...rounds: Script[]): void {
  for (const round of rounds) {
    chain.mockImplementationOnce(async (_providers: ProviderConfig[], request: ChainRequest) => {
      const text = round.text ?? '';
      const size = round.chunk ?? 3;
      const pieces = round.chunks ?? Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
      const answers: Array<boolean | void> = [];
      returned.push(answers);
      let useful = false;
      for (const piece of pieces) {
        const verdict = request.onText(piece);
        answers.push(verdict);
        // The chain's own rule: no verdict, or a true verdict, counts as output.
        if (verdict === undefined || verdict) useful = true;
      }
      if (round.throws) throw round.throws;
      const model = round.model ?? 'fake-model';
      if (round.breaks) {
        if (!useful) throw round.breaks;
        return { finish: 'unknown', finishDetail: round.breaks.kind, text: '', model, provider: 'Fake', error: round.breaks } satisfies ChainResult;
      }
      return { finish: round.finish ?? 'stop', finishDetail: '', text: pieces.join(''), model, provider: 'Fake' } satisfies ChainResult;
    });
  }
}

/* ---------- JSONL helpers ---------- */

const rec = (value: unknown) => JSON.stringify(value);
const songRec = (extra: Record<string, unknown> = {}) =>
  rec({ t: 'song', who: '俺が聴き手に', what: '自慢の歌', tone: '強気', motifs: [{ en: 'heat', ja: '熱気' }], ...extra });
const lineRec = (id: number | string, head: string, ja: string, notes: unknown[] = []) =>
  rec({ t: 'line', id: typeof id === 'number' ? `L${id}` : id, head, ja, notes });
const endRec = () => rec({ t: 'end' });
const jsonl = (...records: string[]) => `${records.join('\n')}\n`;

const meta: SongMeta = { title: 'T', artist: 'A' };
const LYRICS = ['I woke up early', 'Brought the heat from the street', 'Yeah', 'We never fall'];
const HEADS = ['I woke up', 'Brought the heat', 'Yeah', 'We never fall'];
const JA = ['早起きした', '通りの熱気を持ってきた', 'イェー', '俺たちは倒れない'];

function makeSource(lines: string[] = LYRICS): SongSource {
  return buildSong(meta, lines.map((text) => ({ kind: 'line' as const, text })));
}

/** A complete answer for LYRICS: song record, four lines, end. */
const fullAnswer = () => jsonl(songRec(), ...HEADS.map((h, i) => lineRec(i + 1, h, JA[i]!)), endRec());

const newRecord = () => emptyRecord('1', '/s', meta);
const options = { providers: [] as ProviderConfig[], thinking: 'low' as const };
const userOf = (call: number): string => (chain.mock.calls[call]![1] as ChainRequest).user;
const jaOf = (source: SongSource, record: SongRecord, uid: number) => record.lines[source.unique[uid - 1]!.key]?.ja;

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

beforeEach(() => {
  chain.mockReset();
  returned = [];
});

afterEach(() => {
  vi.useRealTimers();
});

/* ---------- tests ---------- */

describe('translateSong: a complete song', () => {
  it('applies the song record and every line from a streamed answer', async () => {
    const source = makeSource();
    const record = newRecord();
    script({ text: fullAnswer() });
    const updates: number[] = [];
    const out = await translateSong(source, record, { ...options, onUpdate: (r) => updates.push(Object.keys(r.lines).length) });

    expect(chain).toHaveBeenCalledTimes(1);
    expect(out.complete).toBe(true);
    expect(out.stop).toBeUndefined();
    expect(out.model).toBe('fake-model');
    expect(out.record).toBe(record);
    expect(record.model).toBe('fake-model');
    expect(record.stop).toBeUndefined();
    expect(record.song).toEqual({ who: '俺が聴き手に', what: '自慢の歌', tone: '強気', motifs: [{ en: 'heat', ja: '熱気' }] });
    for (let uid = 1; uid <= 4; uid += 1) expect(record.lines[source.unique[uid - 1]!.key]).toEqual({ ja: JA[uid - 1] });
    expect(missingLines(source, record)).toEqual([]);

    // every applied batch is reported, lines arrive one at a time
    expect(updates.length).toBeGreaterThanOrEqual(5);
    expect(updates.at(-1)).toBe(4);
    expect([...updates].sort((a, b) => a - b)).toEqual(updates);
  });

  it('sends one request that asks for the song record and every line', async () => {
    const source = makeSource();
    script({ text: fullAnswer() });
    await translateSong(source, newRecord(), options);
    expect(chain).toHaveBeenCalledTimes(1);
    const req = chain.mock.calls[0]![1] as ChainRequest;
    expect(req.user).toContain('まず song レコードを書き、');
    expect(req.user).toContain('L1〜L4 をすべて訳してください');
    expect(req.thinking).toBe('low');
    expect(req.system.length).toBeGreaterThan(100);
    expect(typeof req.onText).toBe('function');
  });

  it('applies a final line record that has no trailing newline', async () => {
    const source = makeSource(['one', 'two']);
    const record = newRecord();
    script({ text: [songRec(), lineRec(1, 'one', '一'), lineRec(2, 'two', '二')].join('\n') });
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(true);
    expect(jaOf(source, record, 2)).toBe('二');
  });

  it('does not need an end record', async () => {
    const source = makeSource(['one', 'two']);
    script({ text: jsonl(songRec(), lineRec(1, 'one', '一'), lineRec(2, 'two', '二')) });
    expect((await translateSong(source, newRecord(), options)).complete).toBe(true);
  });

  it('is not complete just because the model wrote an end record', async () => {
    const source = makeSource(['one', 'two']);
    const record = newRecord();
    script({ text: jsonl(songRec(), lineRec(1, 'one', '一'), endRec()) });
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(false);
    expect(out.stop?.reason).toBe('gaps');
  });

  it('copes with fences, prose, bullets, trailing commas and numeric ids around the records', async () => {
    const source = makeSource(['one', 'two', 'three']);
    const record = newRecord();
    script({
      text: [
        'Sure, here it is:', '```json', songRec(), `- ${lineRec(1, 'one', '一')},`, lineRec('2', 'two', '二'),
        rec({ t: 'line', id: 3, head: 'three', ja: '三' }), '```', '',
      ].join('\n'),
    });
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(true);
    expect(Object.values(record.lines).map((l) => l.ja)).toEqual(['一', '二', '三']);
  });

  it('passes the signal and status callback through to the chain', async () => {
    const source = makeSource(['one']);
    const controller = new AbortController();
    const onStatus = vi.fn();
    script({ text: jsonl(lineRec(1, 'one', '一')) });
    await translateSong(source, newRecord(), { ...options, signal: controller.signal, onStatus });
    expect(chain.mock.calls[0]![2]).toEqual({ signal: controller.signal, onStatus, onAttempt: expect.any(Function) });
  });

  it('keeps and replaces the model name', async () => {
    const source = makeSource(['one']);
    const record = newRecord();
    record.model = 'old-model';
    script({ text: jsonl(lineRec(1, 'one', '一')), model: 'new-model' });
    const out = await translateSong(source, record, options);
    expect(out.model).toBe('new-model');
    expect(record.model).toBe('new-model');
  });

  it('makes no request at all when everything is already translated, and clears a stale stop', async () => {
    const source = makeSource(['a', 'b']);
    const record = newRecord();
    for (const u of source.unique) record.lines[u.key] = { ja: `訳${u.uid}` };
    record.stop = { reason: 'gaps', at: 1 };
    const out = await translateSong(source, record, options);
    expect(chain).not.toHaveBeenCalled();
    expect(out.complete).toBe(true);
    expect(record.stop).toBeUndefined();
  });
});

describe('translateSong: output budget', () => {
  it('asks for at least 8192 tokens for a short song', async () => {
    script({ text: fullAnswer() });
    await translateSong(makeSource(), newRecord(), options);
    const budget = (chain.mock.calls[0]![1] as ChainRequest).maxOutputTokens;
    expect(budget).toBeGreaterThanOrEqual(8192);
    expect(budget).toBeLessThan(65_536);
  });

  it('caps the budget for a very long song', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(200)}`);
    script({ text: '' });
    await translateSong(makeSource(lines), newRecord(), options);
    expect((chain.mock.calls[0]![1] as ChainRequest).maxOutputTokens).toBe(65_536);
  });
});

describe('translateSong: repeats', () => {
  const lines = ['Hook', 'Verse', 'hook!', 'Verse two', 'HOOK'];

  it('marks repeats in the lyrics and translates each distinct line once', async () => {
    const source = makeSource(lines);
    expect(source.unique).toHaveLength(3);
    const record = newRecord();
    script({ text: jsonl(songRec(), lineRec(1, 'Hook', 'フック'), lineRec(2, 'Verse', 'ヴァース'), lineRec(3, 'Verse two', 'ヴァース2'), endRec()) });
    const out = await translateSong(source, record, options);

    expect(userOf(0)).toContain('(=L1) hook!');
    expect(userOf(0)).toContain('(=L1) HOOK');
    expect(userOf(0)).toContain('L1〜L3 をすべて訳してください');
    expect(out.complete).toBe(true);
    expect(Object.keys(record.lines)).toHaveLength(3);
    // all three occurrences of the hook share the one stored translation
    expect(source.lines.filter((l) => l.uid === 1).map((l) => record.lines[l.key]?.ja)).toEqual(['フック', 'フック', 'フック']);
  });

  it('keeps the first translation when the model repeats an id, and ignores ids that do not exist', async () => {
    const source = makeSource(lines);
    const record = newRecord();
    script({
      text: jsonl(
        songRec(), lineRec(1, 'Hook', 'フック'), lineRec(1, 'Hook', '二度目のフック'), lineRec(4, 'hook', '存在しない'),
        lineRec(0, 'x', 'ゼロ'), lineRec(2, 'Verse', 'ヴァース'), lineRec(3, 'Verse two', 'ヴァース2'),
      ),
    });
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(true);
    expect(jaOf(source, record, 1)).toBe('フック');
    expect(Object.values(record.lines).map((l) => l.ja)).toEqual(['フック', 'ヴァース', 'ヴァース2']);
  });
});

describe('translateSong: head validation', () => {
  it('drops a line whose head belongs to another line: it stays missing and the stop is "gaps"', async () => {
    const source = makeSource();
    const record = newRecord();
    script({
      text: jsonl(
        songRec(), lineRec(1, HEADS[0]!, JA[0]!), lineRec(2, 'We never fall', '行がずれた訳'),
        lineRec(3, HEADS[2]!, JA[2]!), lineRec(4, HEADS[3]!, JA[3]!), endRec(),
      ),
    });
    const out = await translateSong(source, record, options);

    expect(out.complete).toBe(false);
    expect(out.stop).toMatchObject({ reason: 'gaps' });
    expect(out.stop?.until).toBeUndefined();
    expect(record.stop).toBe(out.stop);
    expect(jaOf(source, record, 2)).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('行がずれた');
    expect(missingLines(source, record).map((u) => u.uid)).toEqual([2]);
    expect(Object.keys(record.lines)).toHaveLength(3);
  });

  it('a following request asks only for the gap, shows the rest as done, and completes the song', async () => {
    const source = makeSource();
    const record = newRecord();
    script(
      { text: jsonl(songRec(), lineRec(1, HEADS[0]!, JA[0]!), lineRec(2, 'wrong words here', 'ずれ'), lineRec(3, HEADS[2]!, JA[2]!), lineRec(4, HEADS[3]!, JA[3]!)) },
      { text: jsonl(lineRec(2, HEADS[1]!, JA[1]!), endRec()) },
    );
    await translateSong(source, record, options);
    expect(record.stop?.reason).toBe('gaps');

    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(true);
    expect(out.stop).toBeUndefined();
    expect(record.stop).toBeUndefined();
    expect(jaOf(source, record, 2)).toBe(JA[1]);

    const second = userOf(1);
    expect(second).toContain('次の ID だけを訳してください：L2。');
    expect(second).toContain('song レコードは書かずに、');
    expect(second).not.toContain('まず song レコードを書き、');
    expect(second).toContain(`L1: ${LYRICS[0]}  → ${JA[0]}`);
    expect(second).toContain(`L4: ${LYRICS[3]}  → ${JA[3]}`);
    expect(second).toContain(`L2: ${LYRICS[1]}\n`);
    expect(second).toContain(JSON.stringify({ t: 'song', ...record.song }));
  });

  it('accepts a line without a head', async () => {
    const source = makeSource(['one', 'two']);
    const record = newRecord();
    script({ text: jsonl(rec({ t: 'line', id: 'L1', ja: '一' }), rec({ t: 'line', id: 'L2', ja: '二' })) });
    expect((await translateSong(source, record, options)).complete).toBe(true);
  });

  it('every head off by one line means nothing is usable', async () => {
    const source = makeSource();
    const record = newRecord();
    script({ text: jsonl(songRec(), ...HEADS.map((_, i) => lineRec(i + 1, HEADS[(i + 1) % 4]!, JA[i]!))) });
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(false);
    expect(out.stop?.reason).toBe('unusable');
    expect(record.lines).toEqual({});
  });
});

describe('translateSong: stopping early', () => {
  it('finish "length": keeps the lines that arrived, drops the half-written one, stop "length"', async () => {
    const source = makeSource();
    const record = newRecord();
    const cut = lineRec(3, HEADS[2]!, 'イェーの途中').slice(0, -12);
    script({ text: `${jsonl(songRec(), lineRec(1, HEADS[0]!, JA[0]!), lineRec(2, HEADS[1]!, JA[1]!))}${cut}`, finish: 'length' });
    const out = await translateSong(source, record, options);

    expect(out.complete).toBe(false);
    expect(out.stop).toMatchObject({ reason: 'length' });
    expect(record.stop).toBe(out.stop);
    expect(Object.values(record.lines).map((l) => l.ja)).toEqual([JA[0], JA[1]]);
    expect(JSON.stringify(record)).not.toContain('途中');
    expect(record.song?.who).toBe('俺が聴き手に');
  });

  it('finish "length" still applies a complete final record that lacks its newline', async () => {
    const source = makeSource(['one', 'two']);
    const record = newRecord();
    script({ text: [songRec(), lineRec(1, 'one', '一'), lineRec(2, 'two', '二')].join('\n'), finish: 'length' });
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(true);
    expect(record.stop).toBeUndefined();
  });

  it('a song that finished by length but has every line is complete', async () => {
    const source = makeSource(['one']);
    script({ text: jsonl(songRec(), lineRec(1, 'one', '一')), finish: 'length' });
    const out = await translateSong(source, newRecord(), options);
    expect(out.complete).toBe(true);
    expect(out.stop).toBeUndefined();
  });

  it('the next request after a "length" stop resumes where it left off', async () => {
    const source = makeSource();
    const record = newRecord();
    script(
      { text: jsonl(songRec(), lineRec(1, HEADS[0]!, JA[0]!), lineRec(2, HEADS[1]!, JA[1]!)), finish: 'length' },
      { text: jsonl(lineRec(3, HEADS[2]!, JA[2]!), lineRec(4, HEADS[3]!, JA[3]!), endRec()) },
    );
    expect((await translateSong(source, record, options)).stop?.reason).toBe('length');
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(true);
    expect(record.stop).toBeUndefined();
    expect(userOf(1)).toContain('次の ID だけを訳してください：L3〜L4。');
    expect(Object.values(record.lines).map((l) => l.ja)).toEqual(JA);
  });

  // GenerateResult.finish can be 'blocked' (Gemini SAFETY/RECITATION after some text arrived).
  // translateSong only maps 'length', so the reader sees "N lines could not be translated"
  // (gaps) instead of the safety-filter seam sentence that the 'blocked' stop reason exists for
  // (src/core/pipeline.ts:130-131; docs/DESIGN.md §3 "safety filter").
  it('maps a stream that ended with finish "blocked" to the stop reason "blocked"', async () => {
    const source = makeSource();
    script({ text: jsonl(songRec(), lineRec(1, HEADS[0]!, JA[0]!)), finish: 'blocked' });
    const out = await translateSong(source, newRecord(), options);
    expect(out.stop?.reason).toBe('blocked');
  });

  it('zero usable lines is "unusable" and changes nothing', async () => {
    const source = makeSource(['a', 'b']);
    const record = newRecord();
    const onUpdate = vi.fn();
    script({ text: 'Sorry, I cannot help with that.\n' });
    const out = await translateSong(source, record, { ...options, onUpdate });
    expect(out.complete).toBe(false);
    expect(out.stop?.reason).toBe('unusable');
    expect(record.stop).toBe(out.stop);
    expect(record.lines).toEqual({});
    expect(record.song).toBeUndefined();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('a song record and an end record without any line is "unusable", but the song record is kept', async () => {
    const source = makeSource(['a', 'b']);
    const record = newRecord();
    script({ text: jsonl(songRec(), endRec()) });
    const out = await translateSong(source, record, options);
    expect(out.stop?.reason).toBe('unusable');
    expect(record.song?.what).toBe('自慢の歌');
    expect(record.lines).toEqual({});
  });

  it('lines for ids that were not requested count as nothing', async () => {
    const source = makeSource(['a', 'b']);
    const record = newRecord();
    record.lines[source.unique[0]!.key] = { ja: '一' };
    record.song = { who: 'W', what: 'T' };
    script({ text: jsonl(lineRec(1, 'a', '上書き'), lineRec(9, 'z', '存在しない')) });
    const out = await translateSong(source, record, options);
    expect(out.stop?.reason).toBe('unusable');
    expect(jaOf(source, record, 1)).toBe('一');
  });

  it('rethrows an error that is not an LLMError', async () => {
    const boom = new TypeError('programming mistake');
    script({ text: '', throws: boom });
    await expect(translateSong(makeSource(), newRecord(), options)).rejects.toBe(boom);
  });
});

describe('translateSong: errors become a stop, never an exception', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  it('a daily quota with a long retry delay: until = now + the delay, nothing thrown', async () => {
    const source = makeSource();
    const record = newRecord();
    script({ text: '', throws: new LLMError('quota', '無料枠の上限', { status: 429, retryAfterMs: 57_083_000 }) });
    const out = await translateSong(source, record, options);

    expect(out.complete).toBe(false);
    expect(out.stop).toEqual({ reason: 'quota', at: NOW, until: NOW + 57_083_000 });
    expect(record.stop).toBe(out.stop);
    expect(record.lines).toEqual({});
  });

  it('a daily quota without a usable delay: until = the next Pacific midnight', async () => {
    for (const retryAfterMs of [0, 30_000, 60_000]) {
      script({ text: '', throws: new LLMError('quota', 'x', { retryAfterMs }) });
      const out = await translateSong(makeSource(), newRecord(), options);
      expect(out.stop).toEqual({ reason: 'quota', at: NOW, until: nextPacificMidnight(NOW) });
    }
  });

  it('a per-minute limit: until is at least a minute away', async () => {
    script({ text: '', throws: new LLMError('rate', 'slow down') });
    const out = await translateSong(makeSource(), newRecord(), options);
    expect(out.stop?.reason).toBe('rate');
    expect(out.stop!.until!).toBeGreaterThanOrEqual(NOW + 60_000);
    expect(out.stop!.until!).toBe(NOW + 60_000);
  });

  it('a per-minute limit with a longer retry delay waits for that delay', async () => {
    script({ text: '', throws: new LLMError('rate', 'slow down', { retryAfterMs: 90_000 }) });
    const out = await translateSong(makeSource(), newRecord(), options);
    expect(out.stop).toEqual({ reason: 'rate', at: NOW, until: NOW + 90_000 });
  });

  it('the reader stopping it: "stopped", and the lines that had arrived are kept', async () => {
    const source = makeSource();
    const record = newRecord();
    script({
      text: jsonl(songRec(), lineRec(1, HEADS[0]!, JA[0]!), lineRec(2, HEADS[1]!, JA[1]!)),
      throws: new LLMError('aborted', '中止しました。'),
    });
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(false);
    expect(out.stop).toEqual({ reason: 'stopped', at: NOW });
    expect(Object.values(record.lines).map((l) => l.ja)).toEqual([JA[0], JA[1]]);
    expect(record.song).toBeDefined();
    expect(record.stop).toBe(out.stop);
  });

  it('aborting before anything arrived: "stopped" as well', async () => {
    script({ text: '', throws: new LLMError('aborted', 'x') });
    const out = await translateSong(makeSource(), newRecord(), options);
    expect(out.stop).toEqual({ reason: 'stopped', at: NOW });
  });

  it('keeps the old model name when the chain gave up', async () => {
    const record = newRecord();
    record.model = 'old-model';
    script({ text: '', throws: new LLMError('overloaded', 'busy') });
    const out = await translateSong(makeSource(), record, options);
    expect(out.model).toBe('old-model');
    expect(record.model).toBe('old-model');
  });

  it('an error after partial output keeps the lines and maps the stop from the error', async () => {
    const cases: Array<[LLMErrorKind, string]> = [['network', 'network'], ['overloaded', 'busy'], ['timeout', 'network'], ['blocked', 'blocked']];
    for (const [kind, reason] of cases) {
      const source = makeSource();
      const record = newRecord();
      script({
        text: jsonl(songRec(), lineRec(1, HEADS[0]!, JA[0]!), lineRec(2, HEADS[1]!, JA[1]!)),
        breaks: new LLMError(kind, 'broke'),
        model: 'half-model',
      });
      const out = await translateSong(source, record, options);
      expect(out.complete).toBe(false);
      expect(out.stop).toEqual({ reason, at: NOW });
      expect(out.model).toBe('half-model');
      expect(record.model).toBe('half-model');
      expect(Object.values(record.lines).map((l) => l.ja)).toEqual([JA[0], JA[1]]);
    }
  });

  it('a record that was cut off by the error is not applied', async () => {
    const source = makeSource(['one', 'two']);
    const record = newRecord();
    const cut = lineRec(2, 'two', '二の途中').slice(0, -8);
    script({ text: `${jsonl(lineRec(1, 'one', '一'))}${cut}`, breaks: new LLMError('network', 'x') });
    const out = await translateSong(source, record, options);
    expect(out.stop?.reason).toBe('network');
    expect(Object.values(record.lines).map((l) => l.ja)).toEqual(['一']);
  });

  it('an error that arrives with all lines in is not a stop: the song is complete', async () => {
    const source = makeSource();
    const record = newRecord();
    record.stop = { reason: 'gaps', at: 1 };
    script({ text: fullAnswer(), breaks: new LLMError('network', 'dropped at the very end') });
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(true);
    expect(out.stop).toBeUndefined();
    expect(record.stop).toBeUndefined();
  });

  it('a stream that breaks after only the song record is not "useful": the error is thrown by the chain and mapped', async () => {
    const record = newRecord();
    script({ text: jsonl(songRec()), breaks: new LLMError('overloaded', 'busy') });
    const out = await translateSong(makeSource(), record, options);
    expect(returned[0]!.every((v) => v === false)).toBe(true);
    expect(out.stop).toEqual({ reason: 'busy', at: NOW });
    expect(record.song?.who).toBe('俺が聴き手に');
  });

  it.each([
    ['overloaded', 'busy'], ['auth', 'auth'], ['blocked', 'blocked'], ['network', 'network'], ['timeout', 'network'],
    ['bad-request', 'unusable'], ['not-found', 'unusable'], ['empty', 'unusable'], ['unknown', 'unusable'],
  ] as Array<[LLMErrorKind, string]>)('a thrown "%s" error becomes the stop reason "%s"', async (kind, reason) => {
    script({ text: '', throws: new LLMError(kind, 'x') });
    const out = await translateSong(makeSource(), newRecord(), options);
    expect(out.stop).toEqual({ reason, at: NOW });
  });
});

describe('stopFromError', () => {
  it('maps every kind of engine error to a reason', () => {
    const reason = (kind: LLMErrorKind) => stopFromError(new LLMError(kind, 'x'), 1000);
    expect(reason('overloaded')).toEqual({ reason: 'busy', at: 1000 });
    expect(reason('auth')).toEqual({ reason: 'auth', at: 1000 });
    expect(reason('blocked')).toEqual({ reason: 'blocked', at: 1000 });
    expect(reason('network')).toEqual({ reason: 'network', at: 1000 });
    expect(reason('timeout')).toEqual({ reason: 'network', at: 1000 });
    expect(reason('aborted')).toEqual({ reason: 'stopped', at: 1000 });
    for (const kind of ['bad-request', 'not-found', 'truncated', 'empty', 'unknown'] as const) {
      expect(reason(kind)).toEqual({ reason: 'unusable', at: 1000 });
    }
  });

  it('rate waits at least a minute, longer when the provider says so', () => {
    expect(stopFromError(new LLMError('rate', 'x'), 1000)).toEqual({ reason: 'rate', at: 1000, until: 61_000 });
    expect(stopFromError(new LLMError('rate', 'x', { retryAfterMs: 5000 }), 1000).until).toBe(61_000);
    expect(stopFromError(new LLMError('rate', 'x', { retryAfterMs: 120_000 }), 1000).until).toBe(121_000);
  });

  it('quota uses the provider delay only when it is longer than a minute, else the Pacific midnight', () => {
    expect(stopFromError(new LLMError('quota', 'x', { retryAfterMs: 60_001 }), NOW).until).toBe(NOW + 60_001);
    expect(stopFromError(new LLMError('quota', 'x', { retryAfterMs: 60_000 }), NOW).until).toBe(nextPacificMidnight(NOW));
    expect(stopFromError(new LLMError('quota', 'x'), NOW).until).toBe(nextPacificMidnight(NOW));
    expect(stopFromError(new LLMError('quota', 'x'), NOW).until!).toBeGreaterThan(NOW);
  });

  it('defaults "at" to the current time', () => {
    const before = Date.now();
    const stop = stopFromError(new LLMError('auth', 'x'));
    expect(stop.at).toBeGreaterThanOrEqual(before);
    expect(stop.at).toBeLessThanOrEqual(Date.now());
  });
});

describe('the song record', () => {
  it('is kept and not overwritten when a resumed answer writes another one', async () => {
    const source = makeSource();
    const record = newRecord();
    record.song = { who: '元の語り手', what: '元の狙い', tone: '元の語調', motifs: [{ en: 'heat', ja: '元の訳' }] };
    for (const uid of [1, 2]) record.lines[source.unique[uid - 1]!.key] = { ja: JA[uid - 1]! };
    script({
      text: jsonl(songRec({ who: '別の語り手', what: '別の狙い' }), lineRec(3, HEADS[2]!, JA[2]!), lineRec(4, HEADS[3]!, JA[3]!), endRec()),
    });
    const out = await translateSong(source, record, options);

    expect(out.complete).toBe(true);
    expect(record.song).toEqual({ who: '元の語り手', what: '元の狙い', tone: '元の語調', motifs: [{ en: 'heat', ja: '元の訳' }] });
    const user = userOf(0);
    expect(user).toContain('song レコードは書かずに、');
    expect(user).toContain('次の ID だけを訳してください：L3〜L4。');
    expect(user).toContain(JSON.stringify({ t: 'song', ...record.song }));
  });

  it('is requested again, and then stored, when only lines were saved before', async () => {
    const source = makeSource();
    const record = newRecord();
    record.lines[source.unique[0]!.key] = { ja: JA[0]! };
    script({ text: jsonl(songRec(), lineRec(2, HEADS[1]!, JA[1]!), lineRec(3, HEADS[2]!, JA[2]!), lineRec(4, HEADS[3]!, JA[3]!)) });
    await translateSong(source, record, options);
    expect(userOf(0)).toContain('まず song レコードを書き、');
    expect(record.song).toMatchObject({ who: '俺が聴き手に', what: '自慢の歌' });
  });

  it('omits tone and motifs it was not given', async () => {
    const record = newRecord();
    script({ text: jsonl(rec({ t: 'song', who: 'A', what: 'B' }), lineRec(1, 'one', '一')) });
    await translateSong(makeSource(['one']), record, options);
    expect(record.song).toEqual({ who: 'A', what: 'B' });
  });

  it('the first song record in an answer wins over later ones', () => {
    const source = makeSource();
    const record = newRecord();
    const builder = new RecordBuilder(source, record, [1]);
    builder.apply([
      { type: 'song', who: '一つ目', what: 'A' },
      { type: 'song', who: '二つ目', what: 'B' },
    ]);
    expect(record.song).toEqual({ who: '一つ目', what: 'A' });
  });

  it('an incomplete stored song record (no "what") is replaced', () => {
    const source = makeSource();
    const record = newRecord();
    record.song = { who: '誰か', what: '' };
    new RecordBuilder(source, record, [1]).apply([{ type: 'song', who: '新', what: '完全' }]);
    expect(record.song).toEqual({ who: '新', what: '完全' });
  });
});

describe('RecordBuilder', () => {
  const source = makeSource();
  const line = (uid: number, over: Partial<Extract<ProtocolEvent, { type: 'line' }>> = {}): ProtocolEvent =>
    ({ type: 'line', uid, ja: JA[uid - 1] ?? '訳', notes: [], ...over });

  it('counts accepted lines in "added" and head mismatches in "misaligned"', () => {
    const record = newRecord();
    const builder = new RecordBuilder(source, record, [1, 2, 3, 4]);
    expect(builder.apply([
      line(1, { head: HEADS[0] }),
      line(2, { head: 'We never fall' }), // L4's head on L2
      line(3, { head: 'nonsense words here' }),
      line(4, { head: HEADS[3] }),
    ])).toBe(true);
    expect(builder.added).toBe(2);
    expect(builder.misaligned).toBe(2);
    expect(Object.values(record.lines).map((l) => l.ja)).toEqual([JA[0], JA[3]]);
    expect(missingLines(source, record).map((u) => u.uid)).toEqual([2, 3]);
  });

  it('a misaligned line changes nothing and reports no change', () => {
    const record = newRecord();
    const builder = new RecordBuilder(source, record, [2]);
    expect(builder.apply([line(2, { head: 'totally different words' })])).toBe(false);
    expect(builder.misaligned).toBe(1);
    expect(builder.added).toBe(0);
    expect(record.lines).toEqual({});
  });

  it('a line that arrives again later can still fill the gap it left', () => {
    const record = newRecord();
    const builder = new RecordBuilder(source, record, [2]);
    builder.apply([line(2, { head: 'wrong wrong wrong' })]);
    expect(builder.apply([line(2, { head: HEADS[1] })])).toBe(true);
    expect(builder.misaligned).toBe(1);
    expect(builder.added).toBe(1);
  });

  it('ignores lines outside the targets, unknown ids, already translated lines, and end records', () => {
    const record = newRecord();
    record.lines[source.unique[0]!.key] = { ja: '既にある' };
    const builder = new RecordBuilder(source, record, [2, 3]);
    expect(builder.apply([
      line(1), // translated already
      line(4), // not requested
      line(99), // no such line
      line(0),
      { type: 'end' },
    ])).toBe(false);
    expect(record.lines).toEqual({ [source.unique[0]!.key]: { ja: '既にある' } });
    expect(builder.added).toBe(0);
    expect(builder.misaligned).toBe(0);
  });

  it('keeps the first of two records for the same line inside one batch', () => {
    const record = newRecord();
    const builder = new RecordBuilder(source, record, [3]);
    builder.apply([line(3, { ja: '一つ目' }), line(3, { ja: '二つ目' })]);
    expect(jaOf(source, record, 3)).toBe('一つ目');
    expect(builder.added).toBe(1);
  });

  it('reports a change for a song record alone, but does not count it as an added line', () => {
    const builder = new RecordBuilder(source, newRecord(), [1]);
    expect(builder.apply([{ type: 'song', who: 'A', what: 'B' }])).toBe(true);
    expect(builder.added).toBe(0);
  });
});

describe('notes', () => {
  const source = makeSource();
  const targets = [1, 2, 3, 4];
  const noteOn = (raw: Array<{ phrase: string; kind: 'slang' | 'wordplay' | 'reference' | 'idiom' | 'ambiguous'; text: string; conjecture?: boolean; genius?: string }>) =>
    raw.map((n) => ({ conjecture: false, ...n }));

  it('arrive inside the line record with their flags and Genius id', async () => {
    const record = newRecord();
    script({
      text: jsonl(
        songRec(),
        lineRec(1, HEADS[0]!, JA[0]!),
        lineRec(2, HEADS[1]!, JA[1]!, [
          { q: 'heat', k: 'slang', x: '勢い・注目', c: true, g: '123' },
          { q: 'street', k: 'reference', x: '通りの意味', c: false },
        ]),
        lineRec(3, HEADS[2]!, JA[2]!),
        lineRec(4, HEADS[3]!, JA[3]!),
      ),
    });
    await translateSong(source, record, options);

    const first = record.lines[source.unique[0]!.key]!;
    expect(first).toEqual({ ja: JA[0] });
    expect(first).not.toHaveProperty('notes');

    const second = record.lines[source.unique[1]!.key]!;
    expect(second.ja).toBe(JA[1]);
    expect(second.notes).toEqual([
      { kind: 'slang', phrase: 'heat', text: '勢い・注目', conjecture: true, genius: '123' },
      { kind: 'reference', phrase: 'street', text: '通りの意味' },
    ]);
    expect(second.notes![1]).not.toHaveProperty('conjecture');
    expect(second.notes![1]).not.toHaveProperty('genius');
  });

  it('keeps at most three per line and drops duplicates of the same kind and phrase', () => {
    const record = newRecord();
    const builder = new RecordBuilder(source, record, targets);
    builder.apply([{
      type: 'line', uid: 2, ja: JA[1]!, notes: noteOn([
        { phrase: 'heat', kind: 'slang', text: 'slang:heat' },
        { phrase: 'Heat!', kind: 'slang', text: 'duplicate (loosely the same phrase)' },
        { phrase: 'heat', kind: 'idiom', text: 'idiom:heat' },
        { phrase: 'street', kind: 'reference', text: 'reference:street' },
        { phrase: 'Brought', kind: 'wordplay', text: 'fourth distinct note, over the cap' },
      ]),
    }]);
    expect(record.lines[source.unique[1]!.key]!.notes!.map((n) => n.text)).toEqual(['slang:heat', 'idiom:heat', 'reference:street']);
  });

  it('a duplicate does not use up a slot of the cap', () => {
    const record = newRecord();
    new RecordBuilder(source, record, targets).apply([{
      type: 'line', uid: 2, ja: JA[1]!, notes: noteOn([
        { phrase: 'heat', kind: 'slang', text: 'one' },
        { phrase: 'HEAT', kind: 'slang', text: 'dup 1' },
        { phrase: 'heat.', kind: 'slang', text: 'dup 2' },
        { phrase: 'street', kind: 'slang', text: 'two' },
        { phrase: 'brought', kind: 'slang', text: 'three' },
      ]),
    }]);
    expect(record.lines[source.unique[1]!.key]!.notes!.map((n) => n.text)).toEqual(['one', 'two', 'three']);
  });

  it('caps and dedupes notes that come through the whole pipeline', async () => {
    const record = newRecord();
    const many = [
      { q: 'heat', k: 'slang', x: 'a' },
      { q: 'Heat', k: 'slang', x: 'dup' },
      { q: 'street', k: 'pun', x: 'b' },
      { q: 'woke', k: 'nonsense', x: 'dropped by the parser' },
      { q: 'Brought', k: 'idiom', x: 'c' },
      { q: 'from', k: 'reference', x: 'over the cap' },
    ];
    script({ text: jsonl(songRec(), lineRec(2, HEADS[1]!, JA[1]!, many)) });
    await translateSong(source, record, options);
    expect(record.lines[source.unique[1]!.key]!.notes).toEqual([
      { kind: 'slang', phrase: 'heat', text: 'a' },
      { kind: 'wordplay', phrase: 'street', text: 'b' },
      { kind: 'idiom', phrase: 'Brought', text: 'c' },
    ]);
  });

  it('a line whose notes are all unusable is stored without a notes field', async () => {
    const record = newRecord();
    script({ text: jsonl(lineRec(3, HEADS[2]!, JA[2]!, [{ q: '', k: 'slang', x: 'x' }, { q: 'a', k: 'bogus', x: 'x' }])) });
    await translateSong(source, record, options);
    expect(record.lines[source.unique[2]!.key]).toEqual({ ja: JA[2] });
  });

  it('are not added to a line that was translated earlier', () => {
    const record = newRecord();
    record.lines[source.unique[1]!.key] = { ja: '前の訳' };
    new RecordBuilder(source, record, [1]).apply([{
      type: 'line', uid: 2, ja: '新しい訳', notes: noteOn([{ phrase: 'heat', kind: 'slang', text: 'x' }]),
    }]);
    expect(record.lines[source.unique[1]!.key]).toEqual({ ja: '前の訳' });
  });
});

describe('onText verdicts (the chain falls back to another model while they are false)', () => {
  it('is true only once a line record has been applied', async () => {
    const source = makeSource(['one', 'two']);
    const l1 = lineRec(1, 'one', '一');
    script({
      chunks: [
        `${songRec()}\n`, // a complete song record is not progress
        l1.slice(0, 15), // half a line
        `${l1.slice(15)}\n`, // the line completes
        'prose that is not a record\n',
        `${lineRec(2, 'two', '二')}\n`,
      ],
    });
    await translateSong(source, newRecord(), options);
    expect(returned[0]).toEqual([false, false, true, true, true]);
  });

  it('never returns undefined', async () => {
    script({ text: fullAnswer(), chunk: 5 });
    await translateSong(makeSource(), newRecord(), options);
    expect(returned[0]!.length).toBeGreaterThan(10);
    expect(returned[0]!.every((v) => typeof v === 'boolean')).toBe(true);
    expect(returned[0]!.at(-1)).toBe(true);
    // false up to the first complete line record, true from then on
    const first = returned[0]!.indexOf(true);
    expect(first).toBeGreaterThan(0);
    expect(returned[0]!.slice(0, first).every((v) => v === false)).toBe(true);
    expect(returned[0]!.slice(first).every((v) => v === true)).toBe(true);
  });

  it('stays false for an answer without a usable line', async () => {
    script({ chunks: ['Sorry, ', 'I cannot ', 'help.\n', `${songRec()}\n`, `${endRec()}\n`] });
    await translateSong(makeSource(['a']), newRecord(), options);
    expect(returned[0]).toEqual([false, false, false, false, false]);
  });

  it('stays false when every line is misaligned, so a failing stream still falls back', async () => {
    script({ chunks: [`${lineRec(1, 'wrong head words', '訳')}\n`, `${lineRec(2, 'also wrong', '訳')}\n`] });
    await translateSong(makeSource(['one', 'two']), newRecord(), options);
    expect(returned[0]).toEqual([false, false]);
  });

  it('stays false when the only lines are ones that were already translated', async () => {
    const source = makeSource(['one', 'two']);
    const record = newRecord();
    record.lines[source.unique[0]!.key] = { ja: '既訳' };
    script({ chunks: [`${lineRec(1, 'one', '重複')}\n`] });
    await translateSong(source, record, options);
    expect(returned[0]).toEqual([false]);
  });
});

describe('stripGlosses', () => {
  it('drops parenthetical glosses when the source line has no parentheses', () => {
    expect(stripGlosses('会計士の家にはパルメザン（大金）が山積み', "Parmesan where my accountant lives")).toBe('会計士の家にはパルメザンが山積み');
  });

  it('keeps parentheses that mirror the source ad-libs', () => {
    expect(stripGlosses('謙虚になれ（待てよ、ビッチ）', 'Be humble (Hold up, bitch)')).toBe('謙虚になれ（待てよ、ビッチ）');
  });

  it('never empties a line that is only a parenthesis', () => {
    expect(stripGlosses('（イェー）', 'Yeah')).toBe('（イェー）');
  });
});

describe('stripGlosses with trailing source ad-libs', () => {
  it('drops a gloss before the trailing echo group', () => {
    expect(stripGlosses('マンマン（俺）に対してデカい顔してるのは誰だ？', "Who that nigga thinkin' that he frontin' on Man-Man? (Man-Man)"))
      .toBe('マンマンに対してデカい顔してるのは誰だ？');
  });

  it('keeps the trailing groups that mirror the source', () => {
    expect(stripGlosses('座ってろ（待てよ）', 'Sit down (Hold up)')).toBe('座ってろ（待てよ）');
    expect(stripGlosses('ビッチ（クソ）、座ってろ（待てよ）', 'Bitch, sit down (Hold up)')).toBe('ビッチ、座ってろ（待てよ）');
  });

  it('leaves lines with parentheses mid-source alone', () => {
    expect(stripGlosses('（ああ）行くぞ（今）', '(Yeah) let us go (now) right')).toBe('（ああ）行くぞ（今）');
  });
});

describe('widenParens', () => {
  it('turns ASCII parentheses (and the space before them) into tight full-width ones', () => {
    expect(widenParens('そうだ (Yeah, yeah)')).toBe('そうだ（Yeah, yeah）');
    expect(widenParens('黙ってろ (待てよ、バカ野郎)')).toBe('黙ってろ（待てよ、バカ野郎）');
    expect(widenParens('(よし) 行くぞ (今だ)')).toBe('（よし） 行くぞ（今だ）');
  });

  it('leaves full-width groups, unmatched brackets and English contents alone', () => {
    expect(widenParens('座ってろ（待てよ）')).toBe('座ってろ（待てよ）');
    expect(widenParens('半端な (かっこ')).toBe('半端な (かっこ');
    expect(widenParens('入れ子 (外（内）)')).toBe('入れ子 (外（内）)');
    expect(widenParens('ほら (Uh-huh)')).toBe('ほら（Uh-huh）');
  });

  it('is applied to every line the RecordBuilder accepts, after stripGlosses', () => {
    const source = makeSource(['Go (Yeah, yeah)', 'Stay low (wait up, fool)', 'Money on my mind']);
    const record = newRecord();
    new RecordBuilder(source, record, [1, 2, 3]).apply([
      { type: 'line', uid: 1, ja: '行け (Yeah, yeah)', notes: [] },
      { type: 'line', uid: 2, ja: '低くいろ (待てよ、バカ)', notes: [] },
      // no parentheses in the source: the gloss is stripped first, nothing is left to widen
      { type: 'line', uid: 3, ja: '頭の中は金(お金)のこと', notes: [] },
    ]);
    expect(jaOf(source, record, 1)).toBe('行け（Yeah, yeah）');
    expect(jaOf(source, record, 2)).toBe('低くいろ（待てよ、バカ）');
    expect(jaOf(source, record, 3)).toBe('頭の中は金のこと');
  });
});

describe('trimDefinition', () => {
  const n = (kind: NoteKind, text: string): Note => ({ kind, phrase: 'word', text });

  it('drops a slang or idiom note that only defines what the translation already says', () => {
    expect(trimDefinition(n('slang', '旅先でもらう日当のこと。'), 'お前の日当を流してやる')).toBeNull();
    expect(trimDefinition(n('slang', '雪＝コカインを意味するスラング'), 'コカインを売ってた')).toBeNull();
    expect(trimDefinition(n('slang', '警察を指す言葉'), '警察が来る')).toBeNull();
    expect(trimDefinition(n('idiom', '降参するという意味の表現の一種。'), 'もう降参だ')).toBeNull();
    expect(trimDefinition(n('slang', 'ドラッグの売人の略語。'), '売人をやってた')).toBeNull();
    expect(trimDefinition(n('slang', 'チーズ＝お金を意味するスラング'), '金が山積み')).toBeNull();
  });

  it('keeps the definition when the translation kept the word itself', () => {
    for (const [text, ja] of [
      ['チーズ＝お金を意味するスラング', 'パルメザンが山積み'],
      ['警察を指すスラング。', 'ポポが来る'],
      ['ずらかること。', 'ずらかるぜ'], // no kanji or katakana to compare: keep
      ['降参するという意味の表現の一種。', '白旗だ'], // 意味, 表現 are not the meaning
    ] as const) expect(trimDefinition(n('slang', text), ja)).toEqual(n('slang', text));
  });

  it('keeps what follows the definition when it says something about the line', () => {
    const note = trimDefinition({ ...n('slang', '警察を指すスラング。取り締まりへの怒りがこの一語に込められている。'), conjecture: true, genius: '7' }, 'サツ、つまり警察だ');
    expect(note).toEqual({ kind: 'slang', phrase: 'word', text: '取り締まりへの怒りがこの一語に込められている。', conjecture: true, genius: '7' });
  });

  it('drops the note when what follows is too short to stand alone', () => {
    expect(trimDefinition(n('slang', '警察のこと。怒りがある。'), '警察め')).toBeNull();
  });

  it('leaves notes that do not start with a bare definition', () => {
    for (const text of [
      'チーズは金の隠語。高級な暮らしの象徴とも重ねている。',
      'ここでは相手の度胸のなさをからかっている。',
      '金を数えている今と、昔の貧しさを対比している。警察のこと。',
    ]) expect(trimDefinition(n('slang', text), '金と警察と高級')).toEqual(n('slang', text));
  });

  it('keeps a definition-shaped sentence that names two readings', () => {
    const text = '金とコカインの両方を指す。';
    expect(trimDefinition(n('slang', text), '金とコカイン')).toEqual(n('slang', text));
    expect(trimDefinition(n('idiom', '「降りる」の意味と、曲の展開を掛けた表現のこと。'), '降りる展開')?.text).toBe('「降りる」の意味と、曲の展開を掛けた表現のこと。');
  });

  it('never touches reference, wordplay or ambiguous notes', () => {
    for (const kind of ['reference', 'wordplay', 'ambiguous'] as const) {
      expect(trimDefinition(n(kind, '100ドル紙幣のこと。'), '100ドル紙幣')).toEqual(n(kind, '100ドル紙幣のこと。'));
    }
  });

  it('runs inside the RecordBuilder: a dropped definition does not use up a slot of the cap', () => {
    const source = makeSource();
    const record = newRecord();
    new RecordBuilder(source, record, [2]).apply([{
      type: 'line', uid: 2, ja: JA[1]!, notes: [
        { phrase: 'heat', kind: 'slang', text: '熱気のこと。', conjecture: false },
        { phrase: 'street', kind: 'slang', text: '通りを指すスラング。ここでは育った場所への誇りを示している。', conjecture: false },
        { phrase: 'Brought', kind: 'wordplay', text: 'one', conjecture: false },
        { phrase: 'from', kind: 'reference', text: 'two', conjecture: false },
      ],
    }]);
    expect(record.lines[source.unique[1]!.key]!.notes).toEqual([
      { kind: 'slang', phrase: 'street', text: 'ここでは育った場所への誇りを示している。' },
      { kind: 'wordplay', phrase: 'Brought', text: 'one' },
      { kind: 'reference', phrase: 'from', text: 'two' },
    ]);
  });

  it('a line whose only note was a definition is stored without notes', () => {
    const source = makeSource();
    const record = newRecord();
    new RecordBuilder(source, record, [2]).apply([{
      type: 'line', uid: 2, ja: JA[1]!, notes: [{ phrase: 'heat', kind: 'slang', text: '熱気のこと', conjecture: false }],
    }]);
    expect(record.lines[source.unique[1]!.key]).toEqual({ ja: JA[1] });
  });
});

describe('contiguousPhrase', () => {
  const LINE = 'I write my wrongs till the night turns right';

  it('turns parts joined by "/" into the line text from the first part to the last', () => {
    const phrase = contiguousPhrase('write / right', LINE);
    expect(phrase).toBe('write my wrongs till the night turns right');
    expect(locatePhrase(LINE, phrase)).toEqual({ start: 2, end: LINE.length });
  });

  it('does the same for "...", "…" and a full-width slash', () => {
    const line = 'Stack the blocks up, then knock it down like a puzzle game';
    expect(contiguousPhrase('knock it down... puzzle', line)).toBe('knock it down like a puzzle');
    expect(contiguousPhrase('knock it down…puzzle game', line)).toBe('knock it down like a puzzle game');
    expect(contiguousPhrase('Stack／blocks', line)).toBe('Stack the blocks');
  });

  it('matches parts with the same flexible rules as the underline (case, dropped g)', () => {
    const line = "We was runnin' late, nothin' but the city lights";
    expect(contiguousPhrase('Running / nothing', line)).toBe("runnin' late, nothin'");
  });

  it('keeps a phrase that already occurs in the line, slash or ellipsis included', () => {
    expect(contiguousPhrase('AC/DC', 'Blasting AC/DC in the car')).toBe('AC/DC');
    expect(contiguousPhrase('wait... what', 'Hold on, wait... what?')).toBe('wait... what');
    expect(contiguousPhrase('break it down...', 'then break it down slow')).toBe('break it down...');
  });

  it('falls back to the longest part found when the parts are out of order or partly missing', () => {
    expect(contiguousPhrase('hands / cold', 'cold heart, warm hands')).toBe('hands');
    expect(contiguousPhrase('heart / nowhere', 'cold heart, warm hands')).toBe('heart');
  });

  it('leaves the phrase alone when no part is in the line, or there is no join', () => {
    expect(contiguousPhrase('x / y', 'a b')).toBe('x / y');
    expect(contiguousPhrase('not here', LINE)).toBe('not here');
    expect(contiguousPhrase(' / ', LINE)).toBe(' / ');
  });

  it('runs inside the RecordBuilder on every note', () => {
    const source = makeSource([LINE]);
    const record = newRecord();
    new RecordBuilder(source, record, [1]).apply([{
      type: 'line', uid: 1, ja: '夜が明けるまで過ちを書く', notes: [
        { phrase: 'write / wrongs / right', kind: 'wordplay', text: '同じ音の三語を並べている', conjecture: false },
      ],
    }]);
    expect(record.lines[source.unique[0]!.key]!.notes).toEqual([
      { kind: 'wordplay', phrase: 'write my wrongs till the night turns right', text: '同じ音の三語を並べている' },
    ]);
  });
});
