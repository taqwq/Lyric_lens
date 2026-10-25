/*
 * Streaming line protocol the model writes. One record per line, so every completed
 * line is usable the moment it arrives and a cut-off response still keeps everything
 * before the cut:
 *
 *   @about: この曲が何をしている曲か
 *   @voice: 語り手と、誰に向けているか
 *   L12: 日本語訳
 *   N12: slang | original phrase | 説明
 *   N12?: reference | original phrase | 推測を含む説明
 *
 * Plain text (not JSON) also works with every provider, including local models
 * without structured output support.
 */
import { NOTE_KINDS, type NoteKind } from './types';

export type ProtocolEvent =
  | { type: 'about'; text: string }
  | { type: 'voice'; text: string }
  | { type: 'line'; uid: number; ja: string }
  | { type: 'note'; uid: number; kind: NoteKind; span: string; text: string; unsure: boolean };

const KIND_ALIASES: Record<string, NoteKind> = {
  slang: 'slang', aave: 'slang', jargon: 'slang', 'スラング': 'slang',
  wordplay: 'wordplay', pun: 'wordplay', 'double-entendre': 'wordplay', double_entendre: 'wordplay', '言葉遊び': 'wordplay',
  reference: 'reference', ref: 'reference', allusion: 'reference', background: 'reference', '背景': 'reference',
  idiom: 'idiom', expression: 'idiom', '慣用句': 'idiom',
  ambiguity: 'ambiguity', ambiguous: 'ambiguity', '多義': 'ambiguity',
};

const LINE_RE = /^L\s*(\d{1,4})\s*[:：]\s*(.*)$/i;
const NOTE_RE = /^N\s*(\d{1,4})\s*([?？])?\s*[:：]\s*(.+)$/i;
const META_RE = /^@?\s*(about|voice)\s*[:：]\s*(.+)$/i;

function cleanup(raw: string): string {
  return raw
    .replace(/^\s*(?:[-*•]\s+)?/, '')
    .replace(/^\*\*(.+?)\*\*/, '$1')
    .trim();
}

function stripWrappingQuotes(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”')))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

export function parseProtocolLine(raw: string): ProtocolEvent | null {
  const line = cleanup(raw);
  if (!line || line.startsWith('```')) return null;

  let m = LINE_RE.exec(line);
  if (m) {
    const ja = stripWrappingQuotes(m[2] ?? '');
    if (!ja) return null;
    return { type: 'line', uid: Number(m[1]), ja };
  }

  m = NOTE_RE.exec(line);
  if (m) {
    const parts = (m[3] ?? '').split(/\s*[|｜]\s*/);
    if (parts.length < 3) return null;
    const kindRaw = (parts[0] ?? '').toLowerCase().replace(/[^a-z_\-\p{L}]/gu, '');
    const kind = KIND_ALIASES[kindRaw] ?? (NOTE_KINDS as readonly string[]).find((k) => kindRaw.startsWith(k)) as NoteKind | undefined;
    const span = stripWrappingQuotes(parts[1] ?? '').replace(/^[「『]|[」』]$/g, '');
    const text = parts.slice(2).join(' | ').trim();
    if (!kind || !span || !text) return null;
    return { type: 'note', uid: Number(m[1]), kind, span, text, unsure: Boolean(m[2]) };
  }

  m = META_RE.exec(line);
  if (m) {
    const text = (m[2] ?? '').trim();
    if (!text) return null;
    return { type: (m[1] ?? '').toLowerCase() === 'about' ? 'about' : 'voice', text };
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
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const ev = parseProtocolLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  /** Call once the stream ended normally. A cut-off stream should not flush:
   *  its last line may be half a translation. */
  flush(): ProtocolEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    const ev = parseProtocolLine(rest);
    return ev ? [ev] : [];
  }
}
