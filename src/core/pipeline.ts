/*
 * Translates one song. Normally a single request: the model reads the whole song, writes
 * the context, then every unique line with its notes, streamed. If the stream stops early
 * (output limit, dropped connection, provider error after some output), a follow-up
 * request sends the full lyrics again plus the lines already done and asks only for the
 * rest, so the song is always understood as a whole and nothing already received is lost.
 */
import { generateWithFallback } from '../llm/chain';
import { LLMError } from '../llm/errors';
import type { ProviderConfig, ThinkingLevel } from '../llm/types';
import { buildPrompt } from './prompt';
import { ProtocolParser, type ProtocolEvent } from './protocol';
import { looseText, missingLines } from './song';
import type { LineResult, Note, SongRecord, SongSource } from './types';

const MAX_ROUNDS = 3;
const MAX_NOTES_PER_LINE = 3;

export interface TranslateOptions {
  providers: ProviderConfig[];
  thinking: ThinkingLevel;
  signal?: AbortSignal;
  /** Called after every applied batch of events (cheap; UI may throttle). */
  onUpdate?: (record: SongRecord) => void;
  onStatus?: (text: string) => void;
}

function contains(line: string, span: string): boolean {
  const s = looseText(span);
  return Boolean(s) && looseText(line).includes(s);
}

/** Notes reference a line by id and quote a phrase from it. Trust the quote over the id:
 *  if the phrase is not on that line but is on exactly one (or a nearest) other line,
 *  move the note there. */
export function placeNote(source: SongSource, uid: number, span: string): number | null {
  const stated = source.unique[uid - 1];
  if (stated && contains(stated.text, span)) return uid;
  const matches = source.unique.filter((u) => contains(u.text, span));
  if (matches.length) {
    return matches.reduce((best, u) => (Math.abs(u.uid - uid) < Math.abs(best.uid - uid) ? u : best)).uid;
  }
  return stated ? uid : null;
}

export class RecordBuilder {
  private readonly pendingNotes = new Map<number, Note[]>();
  /** uids accepted in this run (others are kept as-is). */
  private readonly targets: Set<number>;
  added = 0;

  constructor(private readonly source: SongSource, readonly record: SongRecord, targets: number[]) {
    this.targets = new Set(targets);
  }

  retarget(targets: number[]): void {
    this.targets.clear();
    targets.forEach((t) => this.targets.add(t));
  }

  apply(events: ProtocolEvent[]): boolean {
    let changed = false;
    for (const ev of events) {
      if (ev.type === 'about' || ev.type === 'voice') {
        const ctx = this.record.context ?? { about: '', voice: '' };
        if (!ctx[ev.type]) {
          ctx[ev.type] = ev.text;
          this.record.context = ctx;
          changed = true;
        }
        continue;
      }
      if (ev.type === 'line') {
        const u = this.source.unique[ev.uid - 1];
        if (!u || !this.targets.has(ev.uid) || this.record.lines[u.key]?.ja) continue;
        const result: LineResult = { ja: ev.ja };
        const notes = this.pendingNotes.get(ev.uid);
        if (notes?.length) result.notes = notes.slice(0, MAX_NOTES_PER_LINE);
        this.pendingNotes.delete(ev.uid);
        this.record.lines[u.key] = result;
        this.added += 1;
        changed = true;
        continue;
      }
      // note
      const uid = placeNote(this.source, ev.uid, ev.span);
      if (uid == null || !this.targets.has(uid)) continue;
      const note: Note = { kind: ev.kind, span: ev.span, text: ev.text };
      if (ev.unsure) note.unsure = true;
      const u = this.source.unique[uid - 1]!;
      const existing = this.record.lines[u.key];
      if (existing) {
        const notes = existing.notes ?? [];
        if (notes.length >= MAX_NOTES_PER_LINE || notes.some((n) => looseText(n.span) === looseText(note.span) && n.kind === note.kind)) continue;
        existing.notes = [...notes, note];
        changed = true;
      } else {
        const list = this.pendingNotes.get(uid) ?? [];
        list.push(note);
        this.pendingNotes.set(uid, list);
      }
    }
    return changed;
  }
}

function outputBudget(expectedChars: number): number {
  // Japanese is ~1 token/char on these tokenizers; leave generous room for thinking.
  return Math.min(65_536, Math.max(8192, Math.round(expectedChars * 2.2) + 6000));
}

export interface TranslateOutcome {
  record: SongRecord;
  complete: boolean;
  model: string;
  provider: string;
}

export async function translateSong(source: SongSource, record: SongRecord, options: TranslateOptions): Promise<TranslateOutcome> {
  let model = record.model ?? '';
  let provider = '';
  let lastError: LLMError | null = null;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const targets = missingLines(source, record);
    if (!targets.length) break;
    const prompt = buildPrompt(source, record, targets);
    const builder = new RecordBuilder(source, record, targets.map((t) => t.uid));
    const parser = new ProtocolParser();
    if (round > 0) options.onStatus?.(`残り${targets.length}行を続けて訳しています`);

    const result = await generateWithFallback(options.providers, {
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: outputBudget(prompt.expectedChars),
      thinking: options.thinking,
      onText: (chunk) => {
        if (builder.apply(parser.feed(chunk))) options.onUpdate?.(record);
      },
    }, { signal: options.signal, onStatus: options.onStatus });

    // Only a cleanly finished stream may flush its last, newline-less line.
    if (result.finish === 'stop' && builder.apply(parser.flush())) options.onUpdate?.(record);
    model = result.model;
    provider = result.provider;
    record.model = model;
    lastError = result.error ?? null;

    if (builder.added === 0) {
      throw lastError ?? new LLMError('empty', '訳を受け取れませんでした。モデルが形式どおりに答えなかった可能性があります。', { detail: result.text.slice(0, 3000) });
    }
  }

  const complete = missingLines(source, record).length === 0;
  if (!complete && lastError) throw lastError;
  return { record, complete, model, provider };
}
