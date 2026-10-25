import './setup';

import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, buildPrompt } from '../src/core/prompt';
import { buildSong, emptyRecord, type RawLyricRow } from '../src/core/song';
import type { SongMeta, SongRecord, UniqueLine } from '../src/core/types';

const meta: SongMeta = { title: 'Test Song', artist: 'Some Artist', album: 'Some Album' };

function tenLineSong(m: SongMeta = meta) {
  const rows: RawLyricRow[] = [{ kind: 'header', text: '[Verse 1]' }];
  for (let i = 1; i <= 10; i += 1) {
    if (i === 6) rows.push({ kind: 'header', text: '[Chorus]' });
    rows.push({ kind: 'line', text: `line number ${i}` });
  }
  return buildSong(m, rows);
}

function recordWith(source: ReturnType<typeof tenLineSong>, uids: number[], withContext: boolean): SongRecord {
  const r = emptyRecord('/x', meta);
  for (const uid of uids) r.lines[source.unique[uid - 1]!.key] = { ja: `訳${uid}` };
  if (withContext) r.context = { about: 'ABOUT-TEXT', voice: 'VOICE-TEXT' };
  return r;
}

const pick = (source: ReturnType<typeof tenLineSong>, uids: number[]): UniqueLine[] => uids.map((u) => source.unique[u - 1]!);

describe('buildPrompt: full translation', () => {
  const source = tenLineSong();
  const prompt = buildPrompt(source, null, source.unique);

  it('uses the shared system prompt and returns the targets', () => {
    expect(prompt.system).toBe(SYSTEM_PROMPT);
    expect(prompt.targets).toBe(source.unique);
  });

  it('asks for @about/@voice and every id', () => {
    expect(prompt.user).toContain('@about と @voice を最初に書き');
    expect(prompt.user).toContain('L1〜L10 をすべて訳してください');
    expect(prompt.user).not.toContain('次のIDだけ');
    expect(prompt.user).not.toContain('これまでの訳');
  });

  it('includes song info, section labels and numbered lyrics', () => {
    expect(prompt.user).toContain('タイトル: Test Song');
    expect(prompt.user).toContain('アーティスト: Some Artist');
    expect(prompt.user).toContain('アルバム: Some Album');
    expect(prompt.user).toContain('[Verse 1]\nL1: line number 1');
    expect(prompt.user).toContain('[Chorus]\nL6: line number 6');
    expect(prompt.user).toContain('L10: line number 10');
  });

  it('a record with no lines and no context is still a full request', () => {
    const p = buildPrompt(source, emptyRecord('/x', meta), source.unique);
    expect(p.user).toContain('@about と @voice を最初に書き');
    expect(p.user).not.toContain('これまでの訳');
  });

  it('repeated lyrics share one id in the lyrics block and the id range counts unique lines', () => {
    const song = buildSong(meta, [
      { kind: 'line', text: 'Hook line' }, { kind: 'line', text: 'Verse line' }, { kind: 'line', text: 'hook line!' },
    ]);
    const p = buildPrompt(song, null, song.unique);
    expect(p.user).toContain('L1〜L2 をすべて訳してください');
    expect(p.user).toContain('L1: Hook line');
    expect(p.user).toContain('L1: hook line!');
    expect(p.user).not.toContain('L3:');
  });
});

describe('buildPrompt: continuation', () => {
  const source = tenLineSong();
  const done = [1, 2, 6, 7, 8, 10];
  const targets = pick(source, [3, 4, 5, 9]);
  const prompt = buildPrompt(source, recordWith(source, done, true), targets);

  it('asks only for the missing ids, compressed into ranges', () => {
    expect(prompt.user).toContain('次のIDだけを訳してください：L3〜L5, L9');
    expect(prompt.user).not.toContain('をすべて訳してください');
  });

  it('does not ask for @about/@voice when the context already exists', () => {
    expect(prompt.user).toContain('@about と @voice は書かずに');
    expect(prompt.user).not.toContain('@about と @voice を最初に書き');
  });

  it('lists the existing translations and context as reference, still showing all lyrics', () => {
    expect(prompt.user).toContain('# これまでの訳');
    expect(prompt.user).toContain('@about: ABOUT-TEXT');
    expect(prompt.user).toContain('@voice: VOICE-TEXT');
    for (const uid of done) expect(prompt.user).toContain(`L${uid}: 訳${uid}`);
    for (const uid of [3, 4, 5, 9]) expect(prompt.user).not.toContain(`L${uid}: 訳`);
    for (let i = 1; i <= 10; i += 1) expect(prompt.user).toContain(`L${i}: line number ${i}`);
  });

  it('asks for context again when lines exist but the context was never produced', () => {
    const p = buildPrompt(source, recordWith(source, done, false), targets);
    expect(p.user).toContain('@about と @voice を最初に書き');
    expect(p.user).toContain('次のIDだけを訳してください：L3〜L5, L9');
    expect(p.user).toContain('# これまでの訳');
    expect(p.user).not.toContain('@about: ');
  });

  it('formats id lists: singles, pairs, unsorted input', () => {
    const ask = (uids: number[]) => /次のIDだけを訳してください：(.*)/.exec(buildPrompt(source, recordWith(source, [], true), pick(source, uids)).user)?.[1];
    expect(ask([9, 3, 5, 4])).toBe('L3〜L5, L9');
    expect(ask([2, 4, 6])).toBe('L2, L4, L6');
    expect(ask([1, 2])).toBe('L1〜L2');
    expect(ask([7])).toBe('L7');
    expect(ask([1, 2, 3, 5, 6, 8, 9, 10])).toBe('L1〜L3, L5〜L6, L8〜L10');
  });

  it('expectedChars grows by a fixed context budget only when context is needed', () => {
    const withContext = buildPrompt(source, recordWith(source, done, true), targets);
    const withoutContext = buildPrompt(source, recordWith(source, done, false), targets);
    expect(withoutContext.expectedChars - withContext.expectedChars).toBeCloseTo(400, 6);
    expect(withContext.expectedChars).toBeGreaterThan(0);
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
