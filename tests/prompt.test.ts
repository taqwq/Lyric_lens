import './setup';

import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, buildPrompt, noteAllowance, noteBudget } from '../src/core/prompt';
import { buildSong, emptyRecord, type RawLyricRow } from '../src/core/song';
import type { GeniusAnnotation, SongContext, SongMeta, SongRecord, UniqueLine } from '../src/core/types';

const meta: SongMeta = { title: 'Test Song', artist: 'Some Artist', album: 'Some Album' };
type Source = ReturnType<typeof buildSong>;

function tenLineSong(m: SongMeta = meta): Source {
  const rows: RawLyricRow[] = [{ kind: 'header', text: '[Verse 1]' }];
  for (let i = 1; i <= 10; i += 1) {
    if (i === 6) rows.push({ kind: 'header', text: '[Chorus]' });
    rows.push({ kind: 'line', text: `line number ${i}` });
  }
  return buildSong(m, rows);
}

const SONG: SongContext = { who: '俺が元恋人に', what: '強がりの裏の未練を見せる曲' };

function recordWith(source: Source, uids: number[], song?: SongContext): SongRecord {
  const r = emptyRecord('1', '/x', meta);
  for (const uid of uids) r.lines[source.unique[uid - 1]!.key] = { ja: `訳${uid}` };
  if (song) r.song = song;
  return r;
}

const pick = (source: Source, uids: number[]): UniqueLine[] => uids.map((u) => source.unique[u - 1]!);

/** The id list after 「次の ID だけを訳してください：」. */
const askedIds = (user: string) => /次の ID だけを訳してください：(.*?)。/.exec(user)?.[1];

const note = (n: number, extra: Partial<GeniusAnnotation> = {}): GeniusAnnotation => ({
  id: `a${String(n).padStart(2, '0')}`,
  fragment: `lyric ${String(n).padStart(2, '0')}`,
  text: 'x'.repeat(600),
  votes: n,
  ...extra,
});

describe('SYSTEM_PROMPT', () => {
  it('describes the three JSONL records and the repeat marker', () => {
    expect(SYSTEM_PROMPT).toContain('{"t":"song"');
    expect(SYSTEM_PROMPT).toContain('{"t":"line"');
    expect(SYSTEM_PROMPT).toContain('{"t":"end"}');
    expect(SYSTEM_PROMPT).toContain('(=L7)');
    for (const kind of ['slang', 'wordplay', 'reference', 'idiom', 'ambiguous']) expect(SYSTEM_PROMPT).toContain(kind);
  });

  it('checks subject and tense before each line, and limits the imperative to subjectless lines', () => {
    expect(SYSTEM_PROMPT).toContain('3. 各行を訳す前に、その英文の主語と時制を確かめる');
    expect(SYSTEM_PROMPT).toContain('主語のある英文は命令文ではない');
    // a leading vocative and a Don't-sentence may still be imperatives
    expect(SYSTEM_PROMPT).toContain('行頭の呼びかけ語を除くと主語が無く、動詞の原形か Don\'t で始まる文だけ');
    expect(SYSTEM_PROMPT).toContain('無変化の過去形');
    expect(SYSTEM_PROMPT).toContain('三人称（あの子・あいつ）');
  });

  it('keeps names as names, translates crude idioms by their meaning, and drops no words', () => {
    expect(SYSTEM_PROMPT).toContain('訳文でもその名前のまま書く');
    expect(SYSTEM_PROMPT).toContain('慣用の意味を同じ強さの口語で訳す');
    expect(SYSTEM_PROMPT).toContain('原文に無い語で解釈を補わない');
    expect(SYSTEM_PROMPT).toContain('原文の語も落とさない');
  });

  it('writes sound ad-libs as katakana sounds, not as words, and keeps address terms translated', () => {
    expect(SYSTEM_PROMPT).toContain('音のままのカタカナ');
    expect(SYSTEM_PROMPT).toContain('エイ');
    expect(SYSTEM_PROMPT).toContain('motifs に入れるときも ja はそのカタカナにする');
    expect(SYSTEM_PROMPT).toContain('音のまま（エイ／アー）訳に残し、「なあ」「だろ」のような同意を求める語にしない');
    expect(SYSTEM_PROMPT).not.toContain('ayy／uh などのアドリブも訳に残す。');
    // address terms stay in the keep-the-word bullet, translated as address terms
    expect(SYSTEM_PROMPT).toContain('行頭・行末の呼びかけ（nigga／motherfucker／homie／girl など）');
    // the katakana rule names only the sounds, never words that carry meaning
    expect(SYSTEM_PROMPT).not.toMatch(/(?:hold up|bitch|homie)[^。]*音のままのカタカナ/);
  });

  it('limits the preface to one short who and a plain, short what', () => {
    expect(SYSTEM_PROMPT).toContain('「誰が誰に」の1文（40字以内。括弧書きやMV・経歴の情報は書かない）');
    expect(SYSTEM_PROMPT).toContain('歌詞の中で語り手が何をしているか（1〜2文・80字以内。歌詞から言えることだけ。評価語やジャンル名で締めない）');
    expect(SYSTEM_PROMPT).not.toContain('あらすじではなく狙いや構図');
  });

  it('asks for one contiguous quoted phrase and no dictionary definitions in notes', () => {
    expect(SYSTEM_PROMPT).toContain('q は原文の行の連続した一部をそのまま1つ');
    expect(SYSTEM_PROMPT).toContain('文頭でも文末でも');
  });

  it('does not spell out glosses the models produced and might copy', () => {
    for (const bad of ['高級ブランデー', '高級マスタード', 'グレード', '股間', 'ナニ']) expect(SYSTEM_PROMPT).not.toContain(bad);
  });

  it('is what buildPrompt returns as system', () => {
    const source = tenLineSong();
    expect(buildPrompt(source, null, source.unique).system).toBe(SYSTEM_PROMPT);
  });
});

describe('buildPrompt: full translation', () => {
  const source = tenLineSong();
  const prompt = buildPrompt(source, null, source.unique);

  it('returns the targets it was given', () => {
    expect(prompt.targets).toBe(source.unique);
  });

  it('asks for the song record first, every id, and the end record', () => {
    expect(prompt.user).toContain('まず song レコードを書き、');
    expect(prompt.user).toContain('L1〜L10 をすべて訳してください。');
    expect(prompt.user).toContain('最後に {"t":"end"} を書いてください。');
    expect(prompt.user).not.toContain('次の ID だけ');
    expect(prompt.user).not.toContain('既に書いた song レコード');
  });

  it('puts the instruction last', () => {
    const at = prompt.user.indexOf('# 指示');
    expect(at).toBeGreaterThan(prompt.user.indexOf('# 歌詞'));
    expect(prompt.user.slice(at).split('\n# ').length).toBe(1);
    expect(prompt.user.endsWith('を書いてください。')).toBe(true);
  });

  it('includes song info, section labels and numbered lyrics', () => {
    expect(prompt.user).toContain('タイトル: Test Song');
    expect(prompt.user).toContain('アーティスト: Some Artist');
    expect(prompt.user).toContain('アルバム: Some Album');
    expect(prompt.user).toContain('[Verse 1]\nL1: line number 1');
    expect(prompt.user).toContain('[Chorus]\nL6: line number 6');
    expect(prompt.user).toContain('L10: line number 10');
  });

  it('is the same request for a record with no lines and no song', () => {
    const p = buildPrompt(source, emptyRecord('1', '/x', meta), source.unique);
    expect(p.user).toBe(prompt.user);
  });

  it('shows no done markers and no repeat markers when nothing is translated and nothing repeats', () => {
    // (the legend line under "# 歌詞" mentions both markers, so look for them at line level)
    expect(prompt.user).not.toContain('  → ');
    expect(prompt.user).not.toMatch(/^\(=L\d+\) /m);
  });
});

describe('buildPrompt: repeats', () => {
  const song = buildSong(meta, [
    { kind: 'header', text: '[Chorus]' }, { kind: 'line', text: 'Hook line' }, { kind: 'line', text: 'Verse line' },
    { kind: 'header', text: '[Verse]' }, { kind: 'line', text: 'Another line' },
    { kind: 'header', text: '[Chorus]' }, { kind: 'line', text: 'hook line!' }, { kind: 'line', text: 'Verse line' },
  ]);

  it('shows the first occurrence as L<n> and every repeat as (=L<n>) with its own text', () => {
    const p = buildPrompt(song, null, song.unique);
    expect(p.user).toContain('L1: Hook line\nL2: Verse line');
    expect(p.user).toContain('L3: Another line');
    expect(p.user).toContain('(=L1) hook line!\n(=L2) Verse line');
    expect(p.user).not.toContain('L1: hook line!');
    expect(p.user).not.toContain('L4:');
    expect(p.user).not.toContain('L5:');
  });

  it('counts only distinct lines in the id range', () => {
    const p = buildPrompt(song, null, song.unique);
    expect(p.user).toContain('L1〜L3 をすべて訳してください');
    expect(askedIds(p.user)).toBeUndefined();
  });

  it('a third occurrence is a repeat of the first too', () => {
    const s = buildSong(meta, ['a', 'b', 'a', 'a'].map((text) => ({ kind: 'line' as const, text })));
    const lyrics = buildPrompt(s, null, s.unique).user;
    expect(lyrics).toContain('L1: a\nL2: b\n(=L1) a\n(=L1) a');
  });

  it('repeats of a translated line carry no translation, only the first occurrence does', () => {
    const r = emptyRecord('1', '/x', meta);
    r.lines[song.unique[0]!.key] = { ja: 'フック' };
    const p = buildPrompt(song, r, pick(song, [2, 3]));
    expect(p.user).toContain('L1: Hook line  → フック');
    expect(p.user).toContain('(=L1) hook line!\n');
    expect(p.user).not.toContain('(=L1) hook line!  →');
    expect(p.user).not.toContain('フック\n(=');
  });
});

describe('buildPrompt: resuming', () => {
  const source = tenLineSong();
  const done = [1, 2, 6, 7, 8, 10];
  const targets = pick(source, [3, 4, 5, 9]);
  const prompt = buildPrompt(source, recordWith(source, done, SONG), targets);

  it('asks only for the missing ids, compressed into ranges', () => {
    expect(prompt.user).toContain('次の ID だけを訳してください：L3〜L5, L9。');
    expect(prompt.user).not.toContain('をすべて訳してください');
    expect(prompt.user).toContain('最後に {"t":"end"} を書いてください。');
  });

  it('marks already-translated lines with their Japanese, and leaves the missing ones bare', () => {
    for (const uid of done) expect(prompt.user).toContain(`L${uid}: line number ${uid}  → 訳${uid}`);
    for (const uid of [3, 4, 5, 9]) {
      expect(prompt.user).toContain(`L${uid}: line number ${uid}\n`);
      expect(prompt.user).not.toContain(`L${uid}: line number ${uid}  →`);
    }
  });

  it('still shows every line of the lyrics', () => {
    for (let i = 1; i <= 10; i += 1) expect(prompt.user).toContain(`L${i}: line number ${i}`);
  });

  it('passes the stored song record back and does not ask for another', () => {
    expect(prompt.user).toContain('# 既に書いた song レコード');
    expect(prompt.user).toContain(JSON.stringify({ t: 'song', ...SONG }));
    expect(prompt.user).toContain('song レコードは書かずに、');
    expect(prompt.user).not.toContain('まず song レコードを書き、');
  });

  it('passes tone and motifs back too', () => {
    const song: SongContext = { ...SONG, tone: '強気', motifs: [{ en: 'gas', ja: '最高' }] };
    const p = buildPrompt(source, recordWith(source, done, song), targets);
    expect(p.user).toContain('{"t":"song","who":"俺が元恋人に","what":"強がりの裏の未練を見せる曲","tone":"強気","motifs":[{"en":"gas","ja":"最高"}]}');
  });

  it('asks for the song record again when lines exist but the song record was never produced', () => {
    const p = buildPrompt(source, recordWith(source, done), targets);
    expect(p.user).toContain('まず song レコードを書き、');
    expect(p.user).toContain('次の ID だけを訳してください：L3〜L5, L9。');
    expect(p.user).not.toContain('既に書いた song レコード');
    expect(p.user).toContain('L1: line number 1  → 訳1'); // done markers are independent of the song record
  });

  it('treats a song record missing who or what as absent', () => {
    for (const song of [{ who: '誰か', what: '' }, { who: '', what: '何か' }] as SongContext[]) {
      const p = buildPrompt(source, recordWith(source, done, song), targets);
      expect(p.user).toContain('まず song レコードを書き、');
      expect(p.user).not.toContain('既に書いた song レコード');
    }
  });

  it('formats id lists: singles, pairs, unsorted input, ranges', () => {
    const ask = (uids: number[]) => askedIds(buildPrompt(source, recordWith(source, [], SONG), pick(source, uids)).user);
    expect(ask([9, 3, 5, 4])).toBe('L3〜L5, L9');
    expect(ask([2, 4, 6])).toBe('L2, L4, L6');
    expect(ask([1, 2])).toBe('L1〜L2');
    expect(ask([7])).toBe('L7');
    expect(ask([1, 2, 3, 5, 6, 8, 9, 10])).toBe('L1〜L3, L5〜L6, L8〜L10');
  });

  it('a request for every line is "all" even when a record exists', () => {
    const p = buildPrompt(source, recordWith(source, [], SONG), source.unique);
    expect(p.user).toContain('L1〜L10 をすべて訳してください。');
    expect(p.user).toContain('song レコードは書かずに、');
  });

  it('expectedChars is smaller by the song-record budget when the song record exists', () => {
    const withSong = buildPrompt(source, recordWith(source, done, SONG), targets);
    const withoutSong = buildPrompt(source, recordWith(source, done), targets);
    expect(withoutSong.expectedChars - withSong.expectedChars).toBeCloseTo(460, 6);
    expect(withSong.expectedChars).toBeGreaterThan(0);
  });

  it('expectedChars adds a bounded amount per target line', () => {
    const one = buildPrompt(source, recordWith(source, [], SONG), pick(source, [1]));
    const two = buildPrompt(source, recordWith(source, [], SONG), pick(source, [1, 2]));
    expect(one.expectedChars).toBeCloseTo(40 + ('line number 1'.length * 1.4 + 60), 6);
    expect(two.expectedChars).toBeGreaterThan(one.expectedChars);

    const longText = 'x'.repeat(1000);
    const long = buildSong(meta, [{ kind: 'line', text: longText }]);
    expect(buildPrompt(long, emptyRecord('1', '/x', meta), long.unique).expectedChars).toBeCloseTo(500 + 220, 6);
  });
});

describe('note ceiling per song', () => {
  const source = tenLineSong();
  const withNotes = (n: number) => {
    const r = recordWith(source, [1, 2, 3], SONG);
    for (let i = 0; i < n; i += 1) r.lines[source.unique[i]!.key] = { ja: `訳${i}`, notes: [{ kind: 'slang', phrase: 'x', text: 'y' }] };
    return r;
  };

  it('noteBudget grows with the song', () => {
    expect(noteBudget(10)).toBe(2);
    expect(noteBudget(60)).toBe(10);
  });

  it('takes the ceiling from the whole song, not from the lines asked for', () => {
    expect(noteAllowance(source, null)).toEqual({ notesLeft: 2, bonusLeft: 2 });
    expect(buildPrompt(source, null, pick(source, [1])).user).toContain('多くても2件');
  });

  it('subtracts notes already in the record, and the bonus only once the ceiling is passed', () => {
    expect(noteAllowance(source, withNotes(1))).toEqual({ notesLeft: 1, bonusLeft: 2 });
    expect(noteAllowance(source, withNotes(3))).toEqual({ notesLeft: 0, bonusLeft: 1 });
    expect(noteAllowance(source, withNotes(5))).toEqual({ notesLeft: 0, bonusLeft: 0 });
  });

  it('states the remaining budget in the prompt', () => {
    expect(buildPrompt(source, withNotes(1), pick(source, [6])).user).toContain('多くても1件');
  });

  it('past the ceiling, allows only wordplay or ambiguous notes, as many as the bonus left', () => {
    const atCeiling = buildPrompt(source, withNotes(2), pick(source, [6])).user;
    expect(atCeiling).toContain('掛詞か二通りに読めるものに限り');
    expect(atCeiling).toContain('多くても2件');
    expect(atCeiling).not.toContain('書かないでください');
    const oneBonusUsed = buildPrompt(source, withNotes(3), pick(source, [6])).user;
    expect(oneBonusUsed).toContain('掛詞か二通りに読めるものに限り');
    expect(oneBonusUsed).toContain('多くても1件');
  });

  it('asks for no notes once the ceiling and the bonus are both spent', () => {
    const spent = buildPrompt(source, withNotes(5), pick(source, [6])).user;
    expect(spent).not.toContain('多くても');
    expect(spent).not.toContain('掛詞');
    expect(spent).toContain('注は今回は書かないでください');
  });
});

describe('buildPrompt: Genius annotations', () => {
  it('lists each annotation with its id, fragment and text, in lyric order', () => {
    const source = tenLineSong({
      ...meta,
      annotations: [
        { id: '77', fragment: 'line number 2', text: 'Second  line\nexplained', votes: 12 },
        { id: '5', fragment: 'line number 9', text: 'Ninth line explained', votes: 40, verified: true },
      ],
    });
    const { user } = buildPrompt(source, null, source.unique);
    expect(user).toContain('# Genius の注釈');
    expect(user).toContain('- [id:77] ▲12 「line number 2」: Second line explained');
    expect(user).toContain('- [id:5] ▲40 公認 「line number 9」: Ninth line explained'); // votes and verification guide the model
    expect(user.indexOf('[id:77]')).toBeLessThan(user.indexOf('[id:5]'));
    // reference material sits between the lyrics and the instruction
    expect(user.indexOf('# 歌詞')).toBeLessThan(user.indexOf('# Genius の注釈'));
    expect(user.indexOf('# Genius の注釈')).toBeLessThan(user.indexOf('# 指示'));
  });

  it('marks an accepted annotation 公認 like a verified one', () => {
    const source = tenLineSong({ ...meta, annotations: [
      { id: '8', fragment: 'line number 3', text: 'Third line explained', votes: 1, accepted: true },
      { id: '9', fragment: 'line number 4', text: 'Fourth line explained', votes: 1 },
    ] });
    const { user } = buildPrompt(source, null, source.unique);
    expect(user).toContain('- [id:8] ▲1 公認 「line number 3」');
    expect(user).toContain('- [id:9] ▲1 「line number 4」');
  });

  it('omits the block without annotations, and drops empty ones', () => {
    const none = tenLineSong();
    expect(buildPrompt(none, null, none.unique).user).not.toContain('# Genius の注釈');
    const empty = tenLineSong({
      ...meta,
      annotations: [
        { id: '1', fragment: '', text: 'no fragment', votes: 9 },
        { id: '2', fragment: 'no text', text: '   ', votes: 9 },
      ],
    });
    expect(buildPrompt(empty, null, empty.unique).user).not.toContain('# Genius の注釈');
  });

  it('clips long fragments to 160 chars and long texts to 520 chars with an ellipsis', () => {
    const source = tenLineSong({
      ...meta,
      annotations: [{ id: '1', fragment: 'あ'.repeat(300), text: 'い'.repeat(900), votes: 5 }],
    });
    const { user } = buildPrompt(source, null, source.unique);
    expect(user).toContain(`「${'あ'.repeat(160)}」`);
    expect(user).not.toContain('あ'.repeat(161));
    expect(user).toContain(`${'い'.repeat(520)}…`);
    expect(user).not.toContain('い'.repeat(521));
  });

  it('keeps the best-voted annotations when the budget runs out, and prints the kept ones in lyric order', () => {
    // 21 annotations of equal size (8 + 520 + 16 = 544 chars): 16 fit into the 9000-char budget.
    // a01 has the fewest votes but is verified, which outweighs any vote count.
    const annotations: GeniusAnnotation[] = [];
    for (let n = 1; n <= 21; n += 1) annotations.push(note(n, n === 1 ? { votes: 0, verified: true } : {}));
    // shuffle the lyric order so "kept" and "ordered by votes" are visibly different from "ordered by id"
    const lyricOrder = [...annotations.slice(10), ...annotations.slice(0, 10)];
    const source = tenLineSong({ ...meta, annotations: lyricOrder });
    const { user } = buildPrompt(source, null, source.unique);
    const shown = [...user.matchAll(/\[id:(a\d\d)\]/g)].map((m) => m[1]!);

    expect(shown).toHaveLength(16);
    // dropped: the five lowest-voted unverified ones (votes 2..6)
    for (const n of [2, 3, 4, 5, 6]) expect(shown).not.toContain(`a0${n}`);
    // kept: the verified a01, and votes 7..21
    expect(shown).toContain('a01');
    for (let n = 7; n <= 21; n += 1) expect(shown).toContain(`a${String(n).padStart(2, '0')}`);
    // printed in the order they were given (lyric order), not by votes
    expect(shown).toEqual(lyricOrder.map((a) => a.id).filter((id) => shown.includes(id)));
  });

  it('skips an annotation that no longer fits but still fits a smaller, lower-voted one', () => {
    const big = Array.from({ length: 16 }, (_, i) => note(i + 10)); // 16 x 544 = 8704 of 9000
    const tooBig = note(5, { id: 'big' }); // 544 > the 296 left
    const tiny: GeniusAnnotation = { id: 'tiny', fragment: 'tiny', text: 'ok', votes: 1 }; // 22
    const source = tenLineSong({ ...meta, annotations: [...big, tooBig, tiny] });
    const shown = [...buildPrompt(source, null, source.unique).user.matchAll(/\[id:([^\]]+)\]/g)].map((m) => m[1]!);
    expect(shown).not.toContain('big');
    expect(shown).toContain('tiny');
    expect(shown).toHaveLength(17);
  });

  it('weighs a verified annotation (+100) above a better-voted unverified one', () => {
    // 17 annotations of equal size, room for 16: the weakest one is dropped.
    const strong = Array.from({ length: 15 }, (_, i) => note(i + 1, { id: `strong${i}`, votes: 200 + i }));
    const verified = note(1, { id: 'verified', votes: 2, verified: true }); // weight 102
    const popular = note(2, { id: 'popular', votes: 80 }); // weight 80
    const source = tenLineSong({ ...meta, annotations: [popular, ...strong, verified] });
    const shown = [...buildPrompt(source, null, source.unique).user.matchAll(/\[id:([^\]]+)\]/g)].map((m) => m[1]!);
    expect(shown).toHaveLength(16);
    expect(shown).toContain('verified');
    expect(shown).not.toContain('popular');
  });

  it('puts the annotations into the one prompt, once', () => {
    const source = tenLineSong({ ...meta, annotations: [{ id: '9', fragment: 'line number 4', text: 'About four', votes: 7 }] });
    const p = buildPrompt(source, null, source.unique);
    expect(p.user.match(/# 指示/g)).toHaveLength(1);
    expect(p.user).toContain('[id:9]');
  });
});

describe('buildPrompt: Genius about text', () => {
  it('clips long text to 1400 chars with an ellipsis', () => {
    const source = tenLineSong({ ...meta, about: 'あ'.repeat(3000) });
    const { user } = buildPrompt(source, null, source.unique);
    expect(user).toContain('# Genius の曲解説');
    expect(user).toContain(`${'あ'.repeat(1400)}…`);
    expect(user).not.toContain('あ'.repeat(1401));
  });

  it('keeps short text whole, with whitespace collapsed', () => {
    const source = tenLineSong({ ...meta, about: 'First   sentence.\n\nSecond\tsentence.' });
    const { user } = buildPrompt(source, null, source.unique);
    expect(user).toContain('First sentence. Second sentence.');
    expect(user).not.toContain('…');
  });

  it('omits the section when there is no about text', () => {
    const source = tenLineSong();
    expect(buildPrompt(source, null, source.unique).user).not.toContain('Genius の曲解説');
  });

  it('falls back to 不明 for missing title / artist', () => {
    const source = tenLineSong({ title: '', artist: '' });
    const { user } = buildPrompt(source, null, source.unique);
    expect(user).toContain('タイトル: 不明');
    expect(user).toContain('アーティスト: 不明');
  });
});
