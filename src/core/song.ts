import { isSoundOnly } from './sounds';
import { KEY_VERSION } from './types';
import type { LyricLine, Section, SongMeta, SongRecord, SongSource, UniqueLine } from './types';

/** Key used to recognise the same lyric line across repeats and across Genius edits
 *  that only touch punctuation, quotes or spacing. */
export function lineKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[\s,.!?;:…]+$/u, '')
    .trim();
}

/** Looser comparison for matching a quoted span against a line. */
export function looseText(text: string): string {
  return lineKey(text).replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export interface RawLyricRow {
  kind: 'line' | 'header';
  text: string;
}

const HEADER_RE = /^\[[^\]\n]{1,160}\]$/;

export function isSectionHeader(text: string): boolean {
  return HEADER_RE.test(text.trim());
}

/** Turns page rows (lines and [Section] headers) into the song model used everywhere else. */
export function buildSong(meta: SongMeta, rows: RawLyricRow[]): SongSource {
  const sections: Section[] = [];
  const lines: LyricLine[] = [];
  const unique: UniqueLine[] = [];
  const byKey = new Map<string, UniqueLine>();
  let pendingLabel: string | null = null;
  let current: Section | null = null;

  for (const row of rows) {
    if (row.kind === 'header') {
      pendingLabel = row.text.trim();
      current = null;
      continue;
    }
    const text = row.text.trim();
    if (!text) continue;
    // Never drop a non-empty line: line i must stay aligned with anchor i on the page.
    const key = lineKey(text) || text;
    if (!current) {
      current = { index: sections.length, label: pendingLabel };
      sections.push(current);
      pendingLabel = null;
    }
    // A line of sounds keeps its place on the page but is not one of the lines to translate.
    if (isSoundOnly(text)) {
      lines.push({ index: lines.length, text, key, uid: 0, occurrence: 0, section: current.index, sound: true });
      continue;
    }
    let u = byKey.get(key);
    if (!u) {
      u = { uid: unique.length + 1, key, text, occurrences: 0 };
      unique.push(u);
      byKey.set(key, u);
    }
    lines.push({ index: lines.length, text, key, uid: u.uid, occurrence: u.occurrences, section: current.index });
    u.occurrences += 1;
  }
  return { meta, sections, lines, unique };
}

/** The lyrics are already Japanese: most lines hold kana/kanji and almost no Latin letters
 *  (a bracketed ad-lib like "(yeah)" does not count). Kept strict so an English song with a
 *  few Japanese words is unaffected. Header rows are already excluded by buildSong; a line
 *  of sounds ("Oh, oh") is in no language, so it does not count either way. */
export function isMostlyJapanese(source: SongSource): boolean {
  if (source.lines.length < 4) return false;
  const lines = source.lines.filter((l) => !l.sound);
  if (!lines.length) return false;
  let ja = 0;
  let kana = 0;
  for (const l of lines) {
    if (/[぀-ヿ]/.test(l.text)) kana += 1;
    const outside = l.text.replace(/\([^)]*\)|（[^）]*）/g, '');
    const latin = (outside.match(/[A-Za-z]/g) ?? []).length;
    if (/[぀-ヿ一-鿿]/.test(outside) && latin < 3) ja += 1;
  }
  // Kana-less CJK lyrics are Chinese: the ideograph rule alone cannot tell them apart.
  return ja / lines.length >= 0.6 && kana / lines.length >= 0.3;
}

export function missingLines(source: SongSource, record: SongRecord | null | undefined): UniqueLine[] {
  if (!record) return source.unique.slice();
  return source.unique.filter((u) => !record.lines[u.key]?.ja);
}

export type SongStatus =
  | { kind: 'none' }
  | { kind: 'complete' }
  | { kind: 'partial'; missing: number; total: number };

export function songStatus(source: SongSource, record: SongRecord | null | undefined): SongStatus {
  const total = source.unique.length;
  const missing = missingLines(source, record).length;
  if (missing === 0) return { kind: 'complete' };
  if (missing === total) return { kind: 'none' };
  return { kind: 'partial', missing, total };
}

export function emptyRecord(id: string, path: string, meta: SongMeta): SongRecord {
  const now = Date.now();
  return { v: 2, keyVersion: KEY_VERSION, id, path, title: meta.title, artist: meta.artist, lines: {}, createdAt: now, updatedAt: now };
}

/** Normalized words, for checking that a model's echo of a line's first words matches it. */
export function headWords(text: string): string[] {
  // Apostrophes at word edges ('Cause, countin') are often dropped when a model echoes words.
  return lineKey(text).replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
}

/** The model echoes the first few English words of each line it translates; a mismatch
 *  means the translation belongs to some other line and must not be shown here. */
export function headMatches(head: string | undefined, text: string): boolean {
  if (!head) return true;
  const want = headWords(head).slice(0, 3);
  if (!want.length) return true;
  if (wordsMatch(want, headWords(text))) return true;
  // A model often drops a leading ad-lib: "(Ayy) Pull up in" is echoed as "Pull up in".
  const bare = text.replace(LEADING_GROUPS, '');
  return bare !== text && wordsMatch(want, headWords(bare));
}

const LEADING_GROUPS = /^\s*(?:[（(][^（）()]*[）)]\s*)+/;

function wordsMatch(want: string[], have: string[]): boolean {
  const hits = want.filter((w, i) => have[i] === w || have[i]?.replace(/in'?$/, 'ing') === w.replace(/in'?$/, 'ing')).length;
  return hits >= Math.min(2, want.length) || have.join(' ').startsWith(want.join(' '));
}
