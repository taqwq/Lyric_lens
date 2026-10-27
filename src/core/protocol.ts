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

const LINE_RECORD = /"t"\s*:\s*"line"/;

/** Escapes the bare " a model wrote inside a string (an English word quoted in a note):
 *  inside a string, a " followed by anything but , : } ] is not the closing one. */
function escapeStrayQuotes(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
    } else if (ch === '\\') {
      out += ch + (text[i + 1] ?? '');
      i += 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      if (j >= text.length || ',:}]'.includes(text[j]!)) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function unescapeString(body: string): string | null {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return null;
  }
}

/** A line record whose JSON is beyond repair but whose id, head and ja are intact keeps
 *  its translation (without notes); anything less is lost. */
function salvageLine(json: string): ProtocolEvent | null {
  if (!LINE_RECORD.test(json)) return null;
  const idText = /"id"\s*:\s*"(L?\d{1,4})"/.exec(json)?.[1];
  const headBody = /"head"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json)?.[1];
  const jaBody = /"ja"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"notes"/.exec(json)?.[1];
  if (idText == null || headBody == null || jaBody == null) return null;
  const uid = uidOf(idText);
  const head = unescapeString(headBody);
  const ja = unescapeString(jaBody);
  if (uid == null || head == null || ja == null) return null;
  const text = stripWrappingQuotes(ja.trim());
  if (!text) return null;
  return { type: 'line', uid, ja: text, notes: [], ...(head.trim() ? { head: head.trim() } : {}) };
}

/** One output line → event, or null when it is not a usable record. */
export function parseRecord(raw: string): ProtocolEvent | null {
  let line = raw.trim();
  if (!line || line.startsWith('```')) return null;
  line = line.replace(/^[-*•]\s+/, '').replace(/,\s*$/, '');
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const json = line.slice(start, end + 1);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    try {
      data = JSON.parse(escapeStrayQuotes(json)) as Record<string, unknown>;
    } catch {
      return salvageLine(json);
    }
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
  /** Line records that could not be read at all, counted across attempts. */
  dropped = 0;
  /** The first 300 characters of the first few of them, for the console. */
  readonly droppedSamples: string[] = [];

  private parse(raw: string, complete: boolean): ProtocolEvent | null {
    const ev = parseRecord(raw);
    // A tail without its closing brace is a stream that was cut, not a record that failed.
    if (!ev && LINE_RECORD.test(raw) && (complete || raw.trimEnd().endsWith('}'))) {
      this.dropped += 1;
      if (this.droppedSamples.length < 3) this.droppedSamples.push(raw.trim().slice(0, 300));
    }
    return ev;
  }

  feed(chunk: string): ProtocolEvent[] {
    this.buffer += chunk;
    const events: ProtocolEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const ev = this.parse(this.buffer.slice(0, nl), true);
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
    const ev = this.parse(this.buffer, false);
    this.buffer = '';
    return ev ? [ev] : [];
  }
}
