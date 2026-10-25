/*
 * Finds where a quoted phrase sits inside a lyric line's DOM text, as a Range, so it can be
 * marked with the CSS Custom Highlight API without wrapping or editing Genius' nodes.
 */
import type { LineText } from './extract';

const QUOTES = "'‘’ʼ`´";
const DQUOTES = '"“”„';

/** Placeholder for a dropped-g ending (nothin' / nothing / nothin). */
const G_ENDING = '\u0000';

function escapeChar(ch: string): string {
  if (QUOTES.includes(ch)) return `[${QUOTES}]`;
  if (DQUOTES.includes(ch)) return `[${DQUOTES}]`;
  if (ch === '…') return '(?:…|\\.{3})';
  if (ch === G_ENDING) return `(?:g|[${QUOTES}])?`;
  if (/\s/.test(ch)) return '\\s+';
  return ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/** Regex matching the phrase with flexible quotes, spacing, ellipses and case, treating
 *  -ing / -in' / -in as the same ending (lyrics and quotes often disagree). */
export function phrasePattern(phrase: string): RegExp | null {
  let text = phrase.trim().replace(/^[\s"“”'‘’.,!?…]+|[\s"“”'‘’.,!?…]+$/g, '').replace(/\.{3}/g, '…');
  if (!text) return null;
  text = text.replace(/([A-Za-z]+)in(?:g|['‘’ʼ])?(?![A-Za-z])/g, `$1in${G_ENDING}`);
  let source = '';
  let lastWasSpace = false;
  for (const ch of text) {
    const space = /\s/.test(ch);
    if (space && lastWasSpace) continue;
    source += escapeChar(ch);
    lastWasSpace = space;
  }
  try {
    return new RegExp(source, 'iu');
  } catch {
    return null;
  }
}

/** Character offsets of the phrase within the line's raw DOM text, or null. */
export function locatePhrase(raw: string, phrase: string): { start: number; end: number } | null {
  const m = phrasePattern(phrase)?.exec(raw);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

function point(line: LineText, offset: number, preferEnd: boolean): { node: Text; offset: number } | null {
  for (let i = 0; i < line.segments.length; i += 1) {
    const seg = line.segments[i]!;
    const len = seg.node.data.length;
    const inside = preferEnd ? offset > seg.offset && offset <= seg.offset + len : offset >= seg.offset && offset < seg.offset + len;
    if (inside) return { node: seg.node, offset: offset - seg.offset };
  }
  return null;
}

/** A live Range over the phrase in the page, or null when it cannot be found (or the
 *  text nodes have been replaced since extraction). */
export function phraseRange(line: LineText | undefined, phrase: string, doc: Document = document): Range | null {
  if (!line || !line.segments.length) return null;
  if (line.segments.some((s) => !s.node.isConnected)) return null;
  const at = locatePhrase(line.raw, phrase);
  if (!at || at.end <= at.start) return null;
  const start = point(line, at.start, false);
  const end = point(line, at.end, true);
  if (!start || !end) return null;
  const range = doc.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return range;
}
