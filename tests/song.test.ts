import './setup';

import { describe, expect, it } from 'vitest';
import type { SongMeta, SongRecord } from '../src/core/types';
import {
  buildSong,
  emptyRecord,
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

  // The doc comment says edits that "only touch punctuation" must map to the same key,
  // but only a single trailing mark is removed, so an ellipsis / doubled mark changes the key
  // ("wait…" NFKC-expands to "wait..." and keeps two dots).
  it.fails('treats a trailing ellipsis like no punctuation', () => {
    expect(lineKey('Wait…')).toBe(lineKey('Wait'));
  });

  it.fails('treats doubled trailing punctuation like a single mark', () => {
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

  it('trims line text and skips blank rows', () => {
    const song = buildSong(meta, [line('  padded  '), line('   '), line('')]);
    expect(song.lines.map((l) => l.text)).toEqual(['padded']);
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

describe('missingLines / songStatus', () => {
  const source = buildSong(meta, [line('a'), line('b'), line('a'), line('c')]);
  const record = (done: string[]): SongRecord => {
    const r = emptyRecord('/x', meta);
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

  it('emptyRecord carries path/title/artist and timestamps', () => {
    const r = emptyRecord('/songs/x', meta);
    expect(r).toMatchObject({ v: 1, path: '/songs/x', title: 'T', artist: 'A', lines: {} });
    expect(r.createdAt).toBe(r.updatedAt);
    expect(r.createdAt).toBeGreaterThan(0);
  });
});
