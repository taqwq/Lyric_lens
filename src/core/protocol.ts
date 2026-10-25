/*
 * The model answers with line-delimited JSON (docs/DESIGN.md §8), one record per line:
 *
 *   {"t":"song","who":"…","what":"…","tone":"…","motifs":[{"en":"…","ja":"…"}]}
 *   {"t":"line","id":"L12","head":"first three words","ja":"…","notes":[{"q":"…","k":"slang","x":"…","c":false,"g":"123"}]}
 *   {"t":"end"}
 *
 * Every completed line is usable the moment it arrives, a record that fails to parse costs
 * only that line, and a cut-off stream keeps everything before the cut.
 */
import { NOTE_KINDS, type NoteKind } from './types';

export interface RawNote {
  phrase: string;
  kind: NoteKind;
  text: string;
  conjecture: boolean;
  genius?: string;
}

export type ProtocolEvent =
  | { type: 'song'; who: string; what: string; tone?: string; motifs?: Array<{ en: string; ja: string }> }
  | { type: 'line'; uid: number; head?: string; ja: string; notes: RawNote[] }
  | { type: 'end' };

const KIND_ALIASES: Record<string, NoteKind> = {
  slang: 'slang', aave: 'slang', jargon: 'slang', 'スラング': 'slang',
  wordplay: 'wordplay', pun: 'wordplay', 'double-entendre': 'wordplay', double_entendre: 'wordplay', '掛詞': 'wordplay',
  reference: 'reference', ref: 'reference', allusion: 'reference', background: 'reference', '引用': 'reference', '元ネタ': 'reference',
  idiom: 'idiom', expression: 'idiom', '慣用句': 'idiom',
  ambiguous: 'ambiguous', ambiguity: 'ambiguous', '二通りに読める': 'ambiguous', '多義': 'ambiguous',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function kindOf(value: unknown): NoteKind | null {
  const raw = str(value).toLowerCase();
  return KIND_ALIASES[raw] ?? (NOTE_KINDS.find((k) => raw.startsWith(k)) ?? null);
}

function uidOf(value: unknown): number | null {
  const m = /^\s*L?\s*(\d{1,4})\s*$/i.exec(str(value));
  return m ? Number(m[1]) : null;
}

const PAIRS: Record<string, string> = { '"': '"', '“': '”', '「': '」', '『': '』' };

/** Removes one pair of quotes wrapping the whole text — but not 「待て」と「行け」,
 *  whose first and last brackets belong to different pairs. */
function stripWrappingQuotes(text: string): string {
  const t = text.trim();
  const close = PAIRS[t[0] ?? ''];
  if (t.length < 2 || !close || !t.endsWith(close)) return t;
  const inner = t.slice(1, -1);
  if (inner.includes(close) || (close !== t[0] && inner.includes(t[0]!))) return t;
  return inner.trim();
}

function notesOf(value: unknown): RawNote[] {
  if (!Array.isArray(value)) return [];
  const out: RawNote[] = [];
  for (const n of value as Array<Record<string, unknown>>) {
    if (!n || typeof n !== 'object') continue;
    const kind = kindOf(n.k ?? n.kind);
    const phrase = stripWrappingQuotes(str(n.q ?? n.phrase ?? n.span));
    const text = str(n.x ?? n.text ?? n.note);
    if (!kind || !phrase || !text) continue;
    const c = n.c ?? n.conjecture;
    const genius = str(n.g ?? n.genius);
    out.push({ phrase, kind, text, conjecture: c === true || c === 'true' || c === 1, ...(genius ? { genius } : {}) });
  }
  return out;
}

/** One output line → event, or null when it is not a usable record. */
export function parseRecord(raw: string): ProtocolEvent | null {
  let line = raw.trim();
  if (!line || line.startsWith('```')) return null;
  line = line.replace(/^[-*•]\s+/, '').replace(/,\s*$/, '');
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const t = str(data.t ?? data.type).toLowerCase();
  if (t === 'end') return { type: 'end' };
  if (t === 'song') {
    const who = str(data.who);
    const what = str(data.what);
    if (!who && !what) return null;
    const motifs = Array.isArray(data.motifs)
      ? (data.motifs as Array<Record<string, unknown>>).map((m) => ({ en: str(m?.en), ja: str(m?.ja) })).filter((m) => m.en && m.ja)
      : undefined;
    const tone = str(data.tone);
    return { type: 'song', who, what, ...(tone ? { tone } : {}), ...(motifs?.length ? { motifs } : {}) };
  }
  if (t === 'line' || (!t && data.id != null && data.ja != null)) {
    const uid = uidOf(data.id);
    const ja = stripWrappingQuotes(str(data.ja));
    if (uid == null || !ja) return null;
    const head = str(data.head);
    return { type: 'line', uid, ja, notes: notesOf(data.notes), ...(head ? { head } : {}) };
  }
  return null;
}

/** Incremental parser: feed arbitrary text chunks, get events for each completed line. */
export class ProtocolParser {
  private buffer = '';

  feed(chunk: string): ProtocolEvent[] {
    this.buffer += chunk;
    const events: ProtocolEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const ev = parseRecord(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
      if (ev) events.push(ev);
    }
    return events;
  }

  /** Drops a half-received line (a failed attempt's tail) before the next attempt streams. */
  reset(): void {
    this.buffer = '';
  }

  /** The last line has no newline; a JSON record is self-delimiting, so it is safe to
   *  parse even after a cut (a truncated record simply fails to parse). */
  flush(): ProtocolEvent[] {
    const ev = parseRecord(this.buffer);
    this.buffer = '';
    return ev ? [ev] : [];
  }
}
