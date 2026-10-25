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
    .replace(/\s*([,.!?;:])\s*$/g, '')
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
    let u = byKey.get(key);
    if (!u) {
      u = { uid: unique.length + 1, key, text, occurrences: 0 };
      unique.push(u);
      byKey.set(key, u);
    }
    u.occurrences += 1;
    lines.push({ index: lines.length, text, key, uid: u.uid, section: current.index });
  }
  return { meta, sections, lines, unique };
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

export function emptyRecord(path: string, meta: SongMeta): SongRecord {
  const now = Date.now();
  return { v: 1, path, title: meta.title, artist: meta.artist, lines: {}, createdAt: now, updatedAt: now };
}
