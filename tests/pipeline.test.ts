import './setup';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateWithFallback, type ChainResult } from '../src/llm/chain';
import { LLMError } from '../src/llm/errors';
import type { ProviderConfig } from '../src/llm/types';
import { RecordBuilder, placeNote, translateSong } from '../src/core/pipeline';
import { buildSong, emptyRecord, missingLines } from '../src/core/song';
import type { SongMeta, SongRecord, SongSource } from '../src/core/types';

vi.mock('../src/llm/chain', () => ({ generateWithFallback: vi.fn() }));

const chain = vi.mocked(generateWithFallback);

type ChainRequest = Parameters<typeof generateWithFallback>[1];

interface Script {
  text: string;
  finish?: ChainResult['finish'];
  error?: LLMError;
  /** Text reported in the result (the real chain returns '' after a broken stream). */
  resultText?: string;
  chunk?: number;
}

/** Makes the next chain call stream `text` in small chunks through request.onText. */
function script(...rounds: Script[]): void {
  for (const round of rounds) {
    chain.mockImplementationOnce(async (_providers: ProviderConfig[], request: ChainRequest) => {
      const size = round.chunk ?? 3;
      for (let i = 0; i < round.text.length; i += size) request.onText(round.text.slice(i, i + size));
      const result: ChainResult = {
        finish: round.finish ?? 'stop',
        finishDetail: '',
        text: round.resultText ?? round.text,
        model: 'fake-model',
        provider: 'Fake',
      };
      if (round.error) result.error = round.error;
      return result;
    });
  }
}

const meta: SongMeta = { title: 'T', artist: 'A' };
const LYRICS = ['I woke up early', 'Brought the heat from the street', 'Yeah', 'We never fall'];

function makeSource(lines: string[] = LYRICS): SongSource {
  return buildSong(meta, lines.map((text) => ({ kind: 'line' as const, text })));
}

const options = { providers: [] as ProviderConfig[], thinking: 'low' as const };

function userOf(call: number): string {
  return (chain.mock.calls[call]![1] as ChainRequest).user;
}

beforeEach(() => {
  chain.mockReset();
});

describe('translateSong: single round', () => {
  it('applies context and every line from a streamed complete answer', async () => {
    const source = makeSource();
    const record = emptyRecord('/s', meta);
    script({
      text: '@about: 自慢の歌\n@voice: 俺が語る\nL1: 早起きした\nL2: 通りの熱気を持ってきた\nL3: イェー\nL4: 俺たちは倒れない\n',
    });
    const updates: number[] = [];
    const out = await translateSong(source, record, { ...options, onUpdate: (r) => updates.push(Object.keys(r.lines).length) });

    expect(chain).toHaveBeenCalledTimes(1);
    expect(out.complete).toBe(true);
    expect(out.model).toBe('fake-model');
    expect(out.provider).toBe('Fake');
    expect(out.record).toBe(record);
    expect(record.model).toBe('fake-model');
    expect(record.context).toEqual({ about: '自慢の歌', voice: '俺が語る' });
    expect(record.lines[source.unique[0]!.key]).toEqual({ ja: '早起きした' });
    expect(record.lines[source.unique[3]!.key]).toEqual({ ja: '俺たちは倒れない' });
    expect(missingLines(source, record)).toEqual([]);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1)).toBe(4);
    // first request asks for everything and passes thinking / abort plumbing through
    expect(userOf(0)).toContain('L1〜L4 をすべて訳してください');
    expect((chain.mock.calls[0]![1] as ChainRequest).thinking).toBe('low');
  });

  it('applies the last line even without a trailing newline when the stream finished cleanly', async () => {
    const source = makeSource(['one', 'two']);
    const record = emptyRecord('/s', meta);
    script({ text: 'L1: 一\nL2: 二', finish: 'stop' });
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(true);
    expect(record.lines[source.unique[1]!.key]!.ja).toBe('二');
  });

  it('passes the signal and status callback through to the chain', async () => {
    const source = makeSource(['one']);
    const controller = new AbortController();
    const onStatus = vi.fn();
    script({ text: 'L1: 一\n' });
    await translateSong(source, emptyRecord('/s', meta), { ...options, signal: controller.signal, onStatus });
    expect(chain.mock.calls[0]![2]).toEqual({ signal: controller.signal, onStatus });
  });

  it('shares one translation between repeated lines', async () => {
    const source = makeSource(['Hook', 'Verse', 'hook!', 'Verse two']);
    expect(source.unique).toHaveLength(3);
    const record = emptyRecord('/s', meta);
    script({ text: 'L1: フック\nL2: ヴァース\nL3: ヴァース2\n' });
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(true);
    expect(userOf(0)).toContain('L1〜L3 をすべて訳してください');
  });
});

describe('translateSong: continuation rounds', () => {
  it('does not apply a half-written last line of a cut-off round, then asks only for the missing ids', async () => {
    const source = makeSource();
    const record = emptyRecord('/s', meta);
    script(
      { text: '@about: A\n@voice: V\nL1: 一行目\nL2: 二行目\nL3: 半分だ', finish: 'length' },
      { text: 'L3: 三行目\nL4: 四行目\n' },
    );
    const onStatus = vi.fn();
    const out = await translateSong(source, record, { ...options, onStatus });

    expect(chain).toHaveBeenCalledTimes(2);
    expect(out.complete).toBe(true);
    // the half line never made it into the record; the follow-up supplied the real one
    expect(record.lines[source.unique[2]!.key]!.ja).toBe('三行目');
    expect(JSON.stringify(record)).not.toContain('半分');

    const second = userOf(1);
    expect(second).toContain('次のIDだけ');
    expect(second).toContain('次のIDだけを訳してください：L3〜L4');
    expect(second).not.toContain('をすべて訳してください');
    expect(second).toContain('@about と @voice は書かずに');
    expect(second).toContain('L1: 一行目'); // already-done lines are shown for consistency
    expect(second).toContain('L2: 二行目');
    // the lyrics are still all there
    for (const text of LYRICS) expect(second).toContain(text);
    expect(onStatus).toHaveBeenCalledWith('残り2行を続けて訳しています');
  });

  it('ignores re-sent lines, notes for finished lines, and lines outside the requested ids', async () => {
    const source = makeSource(['alpha line', 'beta line', 'gamma line']);
    const record = emptyRecord('/s', meta);
    script(
      { text: '@about: A\n@voice: V\nL1: 一\nN1: slang | alpha | 古い注釈\n', finish: 'length' },
      {
        text: [
          '@about: 上書きしない',
          'L1: 上書きされてはいけない',
          'N1: slang | alpha | 二つ目の注釈',
          'L2: 二',
          'L3: 三',
          'L9: 存在しないID',
          '',
        ].join('\n'),
      },
    );
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(true);
    expect(record.context).toEqual({ about: 'A', voice: 'V' });
    expect(record.lines[source.unique[0]!.key]).toEqual({ ja: '一', notes: [{ kind: 'slang', span: 'alpha', text: '古い注釈' }] });
    expect(record.lines[source.unique[1]!.key]!.ja).toBe('二');
    expect(Object.keys(record.lines)).toHaveLength(3);
  });

  it('keeps lines from a round that errored after partial output, and continues', async () => {
    const source = makeSource();
    const record = emptyRecord('/s', meta);
    const dropped = new LLMError('network', 'ネットワークに接続できませんでした。');
    script(
      // the real chain reports text '' and finish 'unknown' after a broken stream
      { text: '@about: A\n@voice: V\nL1: 一\nL2: 二\n', finish: 'unknown', error: dropped, resultText: '' },
      { text: 'L3: 三\nL4: 四\n' },
    );
    const out = await translateSong(source, record, options);
    expect(out.complete).toBe(true);
    expect(chain).toHaveBeenCalledTimes(2);
    expect(userOf(1)).toContain('次のIDだけを訳してください：L3〜L4');
    expect(Object.values(record.lines).map((l) => l.ja)).toEqual(['一', '二', '三', '四']);
  });

  it('does not flush a dangling line after an errored stream', async () => {
    const source = makeSource(['one', 'two']);
    const record = emptyRecord('/s', meta);
    script(
      { text: 'L1: 一\nL2: 半', finish: 'unknown', error: new LLMError('timeout', 'x'), resultText: '' },
      { text: 'L2: 二\n' },
    );
    await translateSong(source, record, options);
    expect(record.lines[source.unique[1]!.key]!.ja).toBe('二');
  });

  it('throws the chain error when the song is still incomplete after an errored round', async () => {
    const source = makeSource(['a', 'b', 'c', 'd', 'e', 'f']);
    const record = emptyRecord('/s', meta);
    const err = new LLMError('overloaded', '混雑');
    // every round yields one new line, then breaks
    script(
      { text: 'L1: 一\n', finish: 'unknown', error: err, resultText: '' },
      { text: 'L2: 二\n', finish: 'unknown', error: err, resultText: '' },
      { text: 'L3: 三\n', finish: 'unknown', error: err, resultText: '' },
    );
    await expect(translateSong(source, record, options)).rejects.toBe(err);
    expect(chain).toHaveBeenCalledTimes(3);
    // nothing already received is lost
    expect(Object.values(record.lines).map((l) => l.ja)).toEqual(['一', '二', '三']);
  });

  it('stops after three rounds and reports incomplete (without throwing) when no round errored', async () => {
    const source = makeSource(['a', 'b', 'c', 'd', 'e']);
    const record = emptyRecord('/s', meta);
    script(
      { text: 'L1: 一\n', finish: 'length' },
      { text: 'L2: 二\n', finish: 'length' },
      { text: 'L3: 三\n', finish: 'length' },
      { text: 'L4: 四\nL5: 五\n' }, // would complete, but is never requested
    );
    const out = await translateSong(source, record, options);
    expect(chain).toHaveBeenCalledTimes(3);
    expect(out.complete).toBe(false);
    expect(missingLines(source, record).map((u) => u.uid)).toEqual([4, 5]);
  });

  it('makes no request at all when everything is already translated', async () => {
    const source = makeSource(['a', 'b']);
    const record = emptyRecord('/s', meta);
    for (const u of source.unique) record.lines[u.key] = { ja: `訳${u.uid}` };
    const out = await translateSong(source, record, options);
    expect(chain).not.toHaveBeenCalled();
    expect(out.complete).toBe(true);
  });
});

describe('translateSong: failures', () => {
  it('throws an empty-answer error when a round produces nothing usable', async () => {
    const source = makeSource(['a', 'b']);
    script({ text: 'Sorry, I cannot help with that.\n' });
    const err = await translateSong(source, emptyRecord('/s', meta), options).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).kind).toBe('empty');
    expect((err as LLMError).detail).toContain('Sorry, I cannot help');
  });

  it('throws the chain error instead when the round also errored', async () => {
    const source = makeSource(['a']);
    const err = new LLMError('network', 'down');
    script({ text: '', finish: 'unknown', error: err, resultText: '' });
    await expect(translateSong(source, emptyRecord('/s', meta), options)).rejects.toBe(err);
  });

  it('keeps earlier lines when a follow-up round produces nothing', async () => {
    const source = makeSource(['a', 'b', 'c']);
    const record = emptyRecord('/s', meta);
    script(
      { text: 'L1: 一\n', finish: 'length' },
      { text: 'no protocol here\n' },
    );
    await expect(translateSong(source, record, options)).rejects.toMatchObject({ kind: 'empty' });
    expect(record.lines[source.unique[0]!.key]!.ja).toBe('一');
  });

  it('an answer consisting only of notes or context counts as nothing', async () => {
    const source = makeSource(['a', 'b']);
    script({ text: '@about: x\nN1: slang | a | y\n' });
    await expect(translateSong(source, emptyRecord('/s', meta), options)).rejects.toMatchObject({ kind: 'empty' });
  });
});

describe('notes', () => {
  const source = makeSource(LYRICS);

  it('placeNote trusts the quoted phrase over the stated id', () => {
    expect(placeNote(source, 1, 'woke up')).toBe(1); // on the stated line
    expect(placeNote(source, 1, 'Brought the heat')).toBe(2); // on a different line
    expect(placeNote(source, 4, 'HEAT, from')).toBe(2); // case / punctuation insensitive
    expect(placeNote(source, 3, 'not anywhere')).toBe(3); // nowhere: keep the stated id
    expect(placeNote(source, 99, 'not anywhere')).toBeNull(); // nowhere and no such line
    expect(placeNote(source, 99, 'woke up')).toBe(1); // no such line but the phrase exists
  });

  it('placeNote picks the nearest line when the phrase appears on several', () => {
    const s = makeSource(['the gas is here', 'middle', 'more gas there', 'x', 'last gas']);
    expect(placeNote(s, 2, 'gas')).toBe(1); // tie between 1 and 3 resolves to the first
    expect(placeNote(s, 4, 'gas')).toBe(3);
    expect(placeNote(s, 5, 'gas')).toBe(5);
    expect(placeNote(s, 4, '')).toBe(4); // empty span never matches; falls back to stated id
  });

  it('moves a note whose quoted span is on a different line, even before that line arrives', async () => {
    const record = emptyRecord('/s', meta);
    script({
      text: '@about: A\n@voice: V\nL1: 一\nN1: slang | heat from the street | 熱気の意味\nL2: 二\nL3: 三\nL4: 四\n',
    });
    await translateSong(source, record, options);
    expect(record.lines[source.unique[0]!.key]!.notes).toBeUndefined();
    expect(record.lines[source.unique[1]!.key]!.notes).toEqual([
      { kind: 'slang', span: 'heat from the street', text: '熱気の意味' },
    ]);
  });

  it('attaches notes that arrive before their L line once the line arrives', async () => {
    const record = emptyRecord('/s', meta);
    script({
      text: 'N2?: reference | heat | 推測の注釈\nL1: 一\nL2: 二\nL3: 三\nL4: 四\n',
    });
    await translateSong(source, record, options);
    expect(record.lines[source.unique[1]!.key]).toEqual({
      ja: '二',
      notes: [{ kind: 'reference', span: 'heat', text: '推測の注釈', unsure: true }],
    });
  });

  it('keeps at most three notes per line and drops duplicates of the same span and kind', () => {
    const record = emptyRecord('/s', meta);
    const builder = new RecordBuilder(source, record, [1, 2, 3, 4]);
    builder.apply([{ type: 'line', uid: 2, ja: '二' }]);
    const note = (kind: 'slang' | 'idiom' | 'reference' | 'wordplay', span: string) =>
      ({ type: 'note', uid: 2, kind, span, text: `${kind}:${span}`, unsure: false }) as const;
    builder.apply([
      note('slang', 'heat'),
      note('slang', 'Heat!'), // same span (loosely) and kind: duplicate
      note('idiom', 'heat'),
      note('reference', 'street'),
      note('wordplay', 'Brought'), // fourth distinct note: over the limit
    ]);
    expect(record.lines[source.unique[1]!.key]!.notes!.map((n) => n.text)).toEqual(['slang:heat', 'idiom:heat', 'reference:street']);
  });

  it('caps the notes that were queued before the line arrived', () => {
    const record = emptyRecord('/s', meta);
    const builder = new RecordBuilder(source, record, [2]);
    const events = ['a', 'b', 'c', 'd'].map((span, i) => ({
      type: 'note', uid: 2, kind: 'idiom', span: i === 0 ? 'heat' : 'street', text: span, unsure: false,
    }) as const);
    builder.apply([...events, { type: 'line', uid: 2, ja: '二' }]);
    expect(record.lines[source.unique[1]!.key]!.notes).toHaveLength(3);
  });

  // Both notes below are queued before the line arrives. The post-line path drops a note with
  // the same span and kind (see test above) but the pre-line queue does not, so the same
  // explanation is stored twice.
  it.fails('also drops duplicate notes that were queued before the line arrived', () => {
    const record = emptyRecord('/s', meta);
    const builder = new RecordBuilder(source, record, [2]);
    const dup = { type: 'note', uid: 2, kind: 'slang', span: 'heat', text: 'same', unsure: false } as const;
    builder.apply([dup, dup, { type: 'line', uid: 2, ja: '二' }]);
    expect(record.lines[source.unique[1]!.key]!.notes).toHaveLength(1);
  });

  it('ignores notes for lines that are not targets of this round', () => {
    const record: SongRecord = emptyRecord('/s', meta);
    const builder = new RecordBuilder(source, record, [3]);
    expect(builder.apply([
      { type: 'note', uid: 2, kind: 'slang', span: 'heat', text: 'x', unsure: false },
      { type: 'line', uid: 2, ja: '二' },
    ])).toBe(false);
    expect(record.lines).toEqual({});
    expect(builder.added).toBe(0);
  });

  it('retarget() lets the same builder accept different ids', () => {
    const record = emptyRecord('/s', meta);
    const builder = new RecordBuilder(source, record, [1]);
    expect(builder.apply([{ type: 'line', uid: 2, ja: '二' }])).toBe(false);
    builder.retarget([2]);
    expect(builder.apply([{ type: 'line', uid: 2, ja: '二' }])).toBe(true);
    expect(builder.added).toBe(1);
  });
});

describe('request shape', () => {
  it('sends the system prompt, an output budget and an onText sink', async () => {
    const source = makeSource(['one']);
    script({ text: 'L1: 一\n' });
    await translateSong(source, emptyRecord('/s', meta), options);
    const req = chain.mock.calls[0]![1] as ChainRequest;
    expect(req.system.length).toBeGreaterThan(100);
    expect(req.maxOutputTokens).toBeGreaterThanOrEqual(8192);
    expect(typeof req.onText).toBe('function');
  });
});
