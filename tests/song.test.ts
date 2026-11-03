import './setup';

import { describe, expect, it } from 'vitest';
import type { SongMeta, SongRecord } from '../src/core/types';
import {
  buildSong,
  emptyRecord,
  headMatches,
  headWords,
  isMostlyJapanese,
  isSectionHeader,
  lineKey,
  looseText,
  missingLines,
  songStatus,
  type RawLyricRow,
} from '../src/core/song';

const meta: SongMeta = { title: 'T', artist: 'A' };
const line = (text: string): RawLyricRow => ({ kind: 'line', text });
const header = (text: string): RawLyricRow => ({ kind: 'header', text });

describe('lineKey', () => {
  it('folds curly quotes to straight quotes', () => {
    expect(lineKey('Don’t stop')).toBe("don't stop");
    expect(lineKey('Don’t stop')).toBe(lineKey("Don't stop"));
    expect(lineKey('He said “hi”')).toBe('he said "hi"');
    expect(lineKey('it`s')).toBe("it's");
  });

  it('is case-insensitive', () => {
    expect(lineKey('HELLO World')).toBe('hello world');
  });

  it('drops one trailing punctuation mark and collapses whitespace', () => {
    expect(lineKey('Hello, world!')).toBe('hello, world');
    expect(lineKey('Hello, world!')).toBe(lineKey('hello,   world'));
    expect(lineKey('  a \t  b  ')).toBe('a b');
    expect(lineKey('Why ?')).toBe('why');
    expect(lineKey('and then;')).toBe('and then');
  });

  it('applies NFKC (full-width, compatibility forms)', () => {
    expect(lineKey('ＨＥＬＬＯ　ＷＯＲＬＤ！')).toBe('hello world');
    expect(lineKey('ｈｅｌｌｏ')).toBe('hello');
    expect(lineKey('① one')).toBe('1 one');
  });

  it('folds the dash family', () => {
    expect(lineKey('well—known')).toBe('well-known');
    expect(lineKey('well–known')).toBe('well-known');
    expect(lineKey('well‐known')).toBe('well-known');
  });

  // The doc comment says edits that "only touch punctuation" must map to the same key.
  it('treats a trailing ellipsis like no punctuation', () => {
    expect(lineKey('Wait…')).toBe(lineKey('Wait'));
  });

  it('treats doubled trailing punctuation like a single mark', () => {
    expect(lineKey('Wait!!')).toBe(lineKey('Wait!'));
  });
});

describe('looseText / isSectionHeader', () => {
  it('looseText drops punctuation but keeps apostrophes', () => {
    expect(looseText('Don’t stop, now!')).toBe("don't stop now");
    expect(looseText('(Skrrt) skrrt')).toBe('skrrt skrrt');
  });

  it('isSectionHeader recognises [..] lines only', () => {
    expect(isSectionHeader('[Chorus: Artist]')).toBe(true);
    expect(isSectionHeader('  [Verse 1]  ')).toBe(true);
    expect(isSectionHeader('[Verse 1] and more')).toBe(false);
    expect(isSectionHeader('no brackets')).toBe(false);
    expect(isSectionHeader('[]')).toBe(false);
  });
});

describe('buildSong', () => {
  it('starts a section at each header and labels it', () => {
    const song = buildSong(meta, [
      header('[Intro]'), line('one'), line('two'),
      header('[Verse 1]'), line('three'),
    ]);
    expect(song.sections).toEqual([
      { index: 0, label: '[Intro]' },
      { index: 1, label: '[Verse 1]' },
    ]);
    expect(song.lines.map((l) => [l.text, l.section, l.index])).toEqual([
      ['one', 0, 0], ['two', 0, 1], ['three', 1, 2],
    ]);
    expect(song.meta).toBe(meta);
  });

  it('puts lines before any header into an unlabeled section', () => {
    const song = buildSong(meta, [line('first'), header('[Chorus]'), line('second')]);
    expect(song.sections.map((s) => s.label)).toEqual([null, '[Chorus]']);
    expect(song.lines.map((l) => l.section)).toEqual([0, 1]);
  });

  it('does not create a section for a header with no lines after it', () => {
    const song = buildSong(meta, [header('[Intro]'), header('[Outro]')]);
    expect(song.sections).toEqual([]);
    expect(song.lines).toEqual([]);
  });

  it('shares the uid between repeated lines and counts occurrences', () => {
    const song = buildSong(meta, [
      line('Hello world'), line('Something else'), line('hello  world!'), line('HELLO WORLD'),
    ]);
    expect(song.lines.map((l) => l.uid)).toEqual([1, 2, 1, 1]);
    expect(song.unique).toHaveLength(2);
    expect(song.unique[0]).toMatchObject({ uid: 1, text: 'Hello world', occurrences: 3 });
    expect(song.unique[1]).toMatchObject({ uid: 2, text: 'Something else', occurrences: 1 });
    expect(song.lines[2]!.key).toBe(song.unique[0]!.key);
  });

  it('numbers the occurrences of each text from 0, in reading order', () => {
    const song = buildSong(meta, [
      line('Hello world'), line('Something else'), line('hello  world!'), line('HELLO WORLD'), line('Something else'),
    ]);
    expect(song.lines.map((l) => l.occurrence)).toEqual([0, 0, 1, 2, 1]);
    expect(song.lines.map((l) => l.uid)).toEqual([1, 2, 1, 1, 2]);
    expect(song.lines.filter((l) => l.occurrence === 0).map((l) => l.text)).toEqual(['Hello world', 'Something else']);
    expect(song.unique.map((u) => u.occurrences)).toEqual([3, 2]);
  });

  it('keeps counting occurrences across sections, including punctuation-only lines', () => {
    const song = buildSong(meta, [
      header('[Chorus]'), line('Hook'), line('!'),
      header('[Verse]'), line('Other'), line('!'),
      header('[Chorus]'), line('Hook'),
    ]);
    expect(song.lines.map((l) => [l.text, l.section, l.occurrence])).toEqual([
      ['Hook', 0, 0], ['!', 0, 0], ['Other', 1, 0], ['!', 1, 1], ['Hook', 2, 1],
    ]);
  });

  it('gives every distinct line occurrences 0..n-1 in order, matching the unique line total', () => {
    const song = buildSong(meta, [line('a'), line('b'), line('A!'), line('c'), line('b'), line('a')]);
    for (const u of song.unique) {
      const mine = song.lines.filter((l) => l.uid === u.uid);
      expect(mine.map((l) => l.occurrence)).toEqual(mine.map((_, i) => i));
      expect(mine).toHaveLength(u.occurrences);
    }
  });

  it('trims line text and skips blank rows', () => {
    const song = buildSong(meta, [line('  padded  '), line('   '), line('')]);
    expect(song.lines.map((l) => l.text)).toEqual(['padded']);
  });

  it('keeps a line of sounds in its place, outside the lines to translate', () => {
    const song = buildSong(meta, [line('Woah, woah'), line('I walk alone'), line('(Yeah, yeah)'), line('Woah, woah'), line('I walk alone')]);
    expect(song.lines.map((l) => l.index)).toEqual([0, 1, 2, 3, 4]);
    expect(song.lines.map((l) => Boolean(l.sound))).toEqual([true, false, true, true, false]);
    expect(song.lines.filter((l) => l.sound).every((l) => l.uid === 0 && l.occurrence === 0)).toBe(true);
    expect(song.unique.map((u) => u.text)).toEqual(['I walk alone']);
    expect(song.lines[4]).toMatchObject({ uid: 1, occurrence: 1 });
  });

  it('a song is complete when every line with words is translated; its sounds never are', () => {
    const song = buildSong(meta, [line('Oh, oh'), line('I walk alone'), line('Yeah')]);
    const r: SongRecord = { ...emptyRecord('1', '/x', meta), lines: { [song.unique[0]!.key]: { ja: 'ひとりで歩く' } } };
    expect(missingLines(song, r)).toEqual([]);
    expect(songStatus(song, r)).toEqual({ kind: 'complete' });
  });

  it('never drops a punctuation-only line (line i must stay aligned with anchor i)', () => {
    const rows = [line('first'), line('!'), line('.'), line('?'), line('!'), line('last')];
    const song = buildSong(meta, rows);
    expect(song.lines).toHaveLength(6);
    expect(song.lines.map((l) => l.text)).toEqual(['first', '!', '.', '?', '!', 'last']);
    // empty normalized key falls back to the raw text, so "!" repeats but "!" and "?" differ
    expect(song.lines[1]!.key).toBe('!');
    expect(song.lines[1]!.uid).toBe(song.lines[4]!.uid);
    expect(new Set([song.lines[1]!.uid, song.lines[2]!.uid, song.lines[3]!.uid]).size).toBe(3);
    expect(song.lines.every((l) => l.key !== '')).toBe(true);
    expect(song.lines.every((l, i) => l.index === i)).toBe(true);
  });
});

describe('isMostlyJapanese', () => {
  const of = (...texts: string[]) => buildSong(meta, texts.map(line));

  it('is true when most lines are kana/kanji with almost no Latin letters', () => {
    expect(isMostlyJapanese(of('きみのこえが とおくで ひびく', '夜明け前の街を歩く', 'La la la', 'もういちど あしたへ'))).toBe(true);
  });

  it('is false for an English song with a few Japanese words', () => {
    expect(isMostlyJapanese(of('I walk the quiet street', 'きみ (yeah)', 'Hold the light', 'Down the road we go'))).toBe(false);
  });

  it('is false for kana-less (Chinese) lyrics', () => {
    expect(isMostlyJapanese(of('夜深人静的街道', '我想念你的笑容', '月光照亮前路', '明天会更好'))).toBe(false);
  });

  it('needs kana in 30% of the lines: 2 of 5 passes, 1 of 5 does not', () => {
    expect(isMostlyJapanese(of('夜深人静的街道', '我想念你的笑容', '月光照亮前路', 'きみの声', 'もういちど'))).toBe(true);
    expect(isMostlyJapanese(of('夜深人静的街道', '我想念你的笑容', '月光照亮前路', '明天会更好', 'もういちど'))).toBe(false);
  });

  it('is false below four lines', () => {
    expect(isMostlyJapanese(of('きみのこえが', '夜明け前の街を歩く', 'もういちど あしたへ'))).toBe(false);
    expect(isMostlyJapanese(of())).toBe(false);
  });

  it('ignores a bracketed Latin ad-lib but not Latin outside brackets', () => {
    expect(isMostlyJapanese(of('きみの声 (oh yeah)', '夜明け前の街（yeah yeah）', '歩いていく', 'もういちど'))).toBe(true);
    expect(isMostlyJapanese(of('きみの声 baby', '夜明け前 baby', '歩いていく', 'もういちど'))).toBe(false);
  });

  it('needs 60% of the lines: 3 of 5 passes, 2 of 5 does not', () => {
    expect(isMostlyJapanese(of('きみの声', '夜明け前', '歩いていく', 'Hold the light', 'Down the road'))).toBe(true);
    expect(isMostlyJapanese(of('きみの声', '夜明け前', 'Hold the light', 'Down the road', 'Run away'))).toBe(false);
  });

  it('does not count lines of sounds either way', () => {
    expect(isMostlyJapanese(of('きみの声', 'Oh, oh, oh', 'Yeah, yeah', 'Woah', '歩いていく', 'La la la'))).toBe(true);
    expect(isMostlyJapanese(of('I walk alone', 'Oh, oh, oh', 'きみの声', 'Yeah, yeah'))).toBe(false);
    expect(isMostlyJapanese(of('Oh', 'Yeah', 'Woah', 'La la'))).toBe(false);
  });

  it('does not count section headers (buildSong drops them)', () => {
    const song = buildSong(meta, [header('[Verse 1]'), line('きみの声'), line('夜明け前'), header('[Chorus]'), line('歩いていく'), line('もういちど')]);
    expect(isMostlyJapanese(song)).toBe(true);
  });
});

describe('missingLines / songStatus', () => {
  const source = buildSong(meta, [line('a'), line('b'), line('a'), line('c')]);
  const record = (done: string[]): SongRecord => {
    const r = emptyRecord('1', '/x', meta);
    for (const k of done) r.lines[k] = { ja: `訳:${k}` };
    return r;
  };

  it('reports everything as missing without a record', () => {
    expect(missingLines(source, null).map((u) => u.uid)).toEqual([1, 2, 3]);
    expect(missingLines(source, undefined)).toHaveLength(3);
    expect(songStatus(source, null)).toEqual({ kind: 'none' });
    expect(songStatus(source, record([]))).toEqual({ kind: 'none' });
  });

  it('reports partial with counts of unique lines', () => {
    const r = record(['a']);
    expect(missingLines(source, r).map((u) => u.text)).toEqual(['b', 'c']);
    expect(songStatus(source, r)).toEqual({ kind: 'partial', missing: 2, total: 3 });
  });

  it('reports complete when every unique line has a translation', () => {
    expect(songStatus(source, record(['a', 'b', 'c']))).toEqual({ kind: 'complete' });
    expect(missingLines(source, record(['a', 'b', 'c']))).toEqual([]);
  });

  it('treats an empty translation as missing', () => {
    const r = record(['a', 'b']);
    r.lines.c = { ja: '' };
    expect(missingLines(source, r).map((u) => u.text)).toEqual(['c']);
    expect(songStatus(source, r)).toEqual({ kind: 'partial', missing: 1, total: 3 });
  });

  it('ignores a stored song record or stop when deciding what is missing', () => {
    const r = record(['a', 'b', 'c']);
    r.stop = { reason: 'gaps', at: 1 };
    expect(songStatus(source, r)).toEqual({ kind: 'complete' });
  });
});

describe('emptyRecord', () => {
  it('carries id, path, title and artist from the meta, and starts with no lines, song or stop', () => {
    const r = emptyRecord('4242', '/Artist-title-lyrics', { title: 'Title', artist: 'Artist', album: 'Album', about: 'About' });
    expect(r).toMatchObject({ v: 2, id: '4242', path: '/Artist-title-lyrics', title: 'Title', artist: 'Artist', lines: {}, keyVersion: 1 });
    expect(r.song).toBeUndefined();
    expect(r.stop).toBeUndefined();
    expect(r.model).toBeUndefined();
    // only persisted fields: no album / about / annotations from the meta
    expect(Object.keys(r).sort()).toEqual(['artist', 'createdAt', 'id', 'keyVersion', 'lines', 'path', 'title', 'updatedAt', 'v']);
  });

  it('stamps createdAt and updatedAt with the same time', () => {
    const before = Date.now();
    const r = emptyRecord('1', '/x', meta);
    expect(r.createdAt).toBe(r.updatedAt);
    expect(r.createdAt).toBeGreaterThanOrEqual(before);
    expect(r.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('returns a fresh lines object each time', () => {
    const a = emptyRecord('1', '/x', meta);
    const b = emptyRecord('1', '/x', meta);
    a.lines.k = { ja: 'x' };
    expect(b.lines).toEqual({});
  });
});

describe('headWords', () => {
  it('lowercases, folds curly quotes, drops punctuation and keeps apostrophes', () => {
    expect(headWords('Don’t stop, NOW!')).toEqual(["don't", 'stop', 'now']);
    expect(headWords('(Skrrt) skrrt')).toEqual(['skrrt', 'skrrt']);
    expect(headWords('  well—known  ')).toEqual(['well', 'known']);
  });

  it('is empty for text without letters or digits', () => {
    expect(headWords('...')).toEqual([]);
    expect(headWords('')).toEqual([]);
  });

  it('keeps digits and non-Latin letters', () => {
    expect(headWords('24 karat 愛してる')).toEqual(['24', 'karat', '愛してる']);
  });
});

describe('headMatches', () => {
  it('accepts a head with or without the leading parenthesised ad-lib', () => {
    const text = '(Ayy) Pull up in the dark';
    expect(headMatches('Pull up in', text)).toBe(true);
    expect(headMatches('(Ayy) Pull up', text)).toBe(true);
    expect(headMatches('Ayy pull up', text)).toBe(true);
    expect(headMatches('Walk down the', text)).toBe(false);
  });

  it('strips several leading groups, but only at the start', () => {
    expect(headMatches('Pull up in', '(Ayy) (Yeah) Pull up in the dark')).toBe(true);
    expect(headMatches('Pull up in', 'Walk (Pull up in) the dark')).toBe(false);
  });

  it('accepts a missing or empty head (the line is then trusted)', () => {
    expect(headMatches(undefined, 'I woke up early')).toBe(true);
    expect(headMatches('', 'I woke up early')).toBe(true);
    expect(headMatches('   ', 'I woke up early')).toBe(true);
    expect(headMatches('...', 'I woke up early')).toBe(true); // nothing to compare
  });

  it('accepts the exact first words', () => {
    expect(headMatches('I woke up', 'I woke up early')).toBe(true);
    expect(headMatches('Brought the heat', 'Brought the heat from the street')).toBe(true);
    expect(headMatches('Yeah', 'Yeah')).toBe(true);
    expect(headMatches('I woke up early today', 'I woke up')).toBe(true); // line shorter than the head
  });

  it('ignores case, curly versus straight quotes, and punctuation', () => {
    expect(headMatches('DON’T STOP ME', "Don't stop me now")).toBe(true);
    expect(headMatches("don't stop me", 'Don’t Stop Me Now')).toBe(true);
    expect(headMatches('Hello, world', 'hello world, again!')).toBe(true);
    expect(headMatches('skrrt skrrt', '(Skrrt) skrrt')).toBe(true);
    expect(headMatches('’Cause I', "'Cause I can't stop")).toBe(true);
  });

  // headWords() keeps a leading apostrophe ("'cause"), so an echo that drops it ("Cause I")
  // shares only one of two words with the line and is rejected, leaving a permanent gap for
  // short lines such as "'Cause I" (src/core/song.ts:93-95, positional compare at :104).
  it("does not reject a head that only differs by the leading apostrophe of 'Cause", () => {
    expect(headMatches('Cause I', "'Cause I can't stop")).toBe(true);
  });

  it("treats -ing and -in' endings as the same word", () => {
    expect(headMatches('goin up', "Goin' up in the club")).toBe(true);
    expect(headMatches('going up', "Goin' up in the club")).toBe(true);
    expect(headMatches("goin' up", 'Going up in the club')).toBe(true);
    expect(headMatches("Runnin' from the", 'Running from the cops')).toBe(true);
    expect(headMatches('Running from the', "Runnin' from the cops")).toBe(true);
    expect(headMatches('Livin la vida', 'Living la vida loca')).toBe(true);
  });

  it('rejects a head that belongs to another line', () => {
    expect(headMatches('Brought the heat', 'I woke up early')).toBe(false);
    expect(headMatches('We never fall', 'Yeah')).toBe(false);
    expect(headMatches('Yeah', 'No')).toBe(false);
    expect(headMatches('we never', 'we always')).toBe(false); // one of two words is not enough
    expect(headMatches('Brought the heat', '')).toBe(false);
  });

  it('only looks at the first three words of the head', () => {
    expect(headMatches('one two three nonsense words', 'one two three four five')).toBe(true);
  });

  it('tolerates one slipped word out of three, but not a line shifted by one word', () => {
    expect(headMatches('I woke early', 'I woke up early')).toBe(true);
    expect(headMatches('the heat from', 'Brought the heat from the street')).toBe(false);
  });
});
