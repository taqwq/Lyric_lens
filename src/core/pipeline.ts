/*
 * One tap, one request (docs/DESIGN.md §1, principle 2). The model reads the whole song,
 * writes the song record, then one record per distinct line, streamed. Whatever arrives is
 * applied (and saved by the caller) immediately. If the stream stops early, the song simply
 * stays partial with a reason; continuing is the reader's next tap, never automatic.
 */
import { generateWithFallback, nextPacificMidnight } from '../llm/chain';
import { LLMError } from '../llm/errors';
import type { ProviderConfig, ThinkingLevel } from '../llm/types';
import { buildPrompt } from './prompt';
import { ProtocolParser, type ProtocolEvent } from './protocol';
import { headMatches, looseText, missingLines } from './song';
import type { LineResult, Note, SongRecord, SongSource, StopInfo } from './types';

const MAX_NOTES_PER_LINE = 3;

export interface TranslateOptions {
  providers: ProviderConfig[];
  thinking: ThinkingLevel;
  signal?: AbortSignal;
  /** Called after every applied batch of records. */
  onUpdate?: (record: SongRecord) => void;
  /** Engine-level progress (which model, waits). Not shown on the reading surface. */
  onStatus?: (text: string) => void;
}

export interface TranslateOutcome {
  record: SongRecord;
  complete: boolean;
  /** Why the song is still partial. */
  stop?: StopInfo;
  model: string;
}

/** Maps an engine error to the reason the reader sees at the seam. */
export function stopFromError(error: LLMError, now = Date.now()): StopInfo {
  switch (error.kind) {
    case 'overloaded': return { reason: 'busy', at: now };
    case 'rate': return { reason: 'rate', at: now, until: now + Math.max(error.retryAfterMs, 60_000) };
    case 'quota': return { reason: 'quota', at: now, until: error.retryAfterMs > 60_000 ? now + error.retryAfterMs : nextPacificMidnight(now) };
    case 'auth': return { reason: 'auth', at: now };
    case 'blocked': return { reason: 'blocked', at: now };
    case 'network':
    case 'timeout': return { reason: 'network', at: now };
    case 'aborted': return { reason: 'stopped', at: now };
    default: return { reason: 'unusable', at: now };
  }
}

const GROUP = '[（(][^（）()]{1,24}[）)]';
const HAS_GROUP = new RegExp(GROUP);
const TRAILING_GROUPS = new RegExp(`(?:\\s*${GROUP})+\\s*$`);
const SOURCE_TRAILING_ONLY = /^[^(（]*(?:[(（][^()（）]*[)）]\s*)+$/;

function dropGroups(text: string): string {
  return text.replace(new RegExp(GROUP, 'g'), '').replace(/\s{2,}/g, ' ').replace(/\s+([、。！？!?])/g, '$1').trim();
}

/** Flash-class models keep adding dictionary glosses in parentheses ("パルメザン（大金）")
 *  despite the prompt. A parenthesis in the translation is legitimate only where the source
 *  has one: with none in the source, all go; when the source's parentheses are trailing
 *  ad-libs or echoes, the translation keeps its trailing groups and loses any before them. */
export function stripGlosses(ja: string, source: string): string {
  if (!HAS_GROUP.test(ja)) return ja;
  if (!/[（(]/.test(source)) return dropGroups(ja) || ja;
  if (!SOURCE_TRAILING_ONLY.test(source.trim())) return ja;
  const tail = TRAILING_GROUPS.exec(ja);
  const head = tail ? ja.slice(0, tail.index) : ja;
  if (!HAS_GROUP.test(head)) return ja;
  const cleaned = dropGroups(head);
  return cleaned ? cleaned + (tail ? tail[0].trimStart() : '') : ja;
}

function sameNote(a: Note, b: Note): boolean {
  return a.kind === b.kind && looseText(a.phrase) === looseText(b.phrase);
}

export class RecordBuilder {
  private readonly targets: Set<number>;
  /** Distinct lines accepted in this request. */
  added = 0;
  /** Line records dropped because their echoed first words did not match the line. */
  misaligned = 0;
  /** The model wrote its {"t":"end"} record. */
  ended = false;

  constructor(private readonly source: SongSource, readonly record: SongRecord, targets: number[]) {
    this.targets = new Set(targets);
  }

  apply(events: ProtocolEvent[]): boolean {
    let changed = false;
    for (const ev of events) {
      if (ev.type === 'song') {
        if (this.record.song?.who && this.record.song.what) continue;
        this.record.song = { who: ev.who, what: ev.what, ...(ev.tone ? { tone: ev.tone } : {}), ...(ev.motifs ? { motifs: ev.motifs } : {}) };
        changed = true;
        continue;
      }
      if (ev.type === 'end') {
        this.ended = true;
        continue;
      }
      if (ev.type !== 'line') continue;
      const u = this.source.unique[ev.uid - 1];
      if (!u || !this.targets.has(ev.uid) || this.record.lines[u.key]?.ja) continue;
      if (!headMatches(ev.head, u.text)) {
        this.misaligned += 1;
        continue;
      }
      const notes: Note[] = [];
      for (const raw of ev.notes) {
        const note: Note = { kind: raw.kind, phrase: raw.phrase, text: raw.text };
        if (raw.conjecture) note.conjecture = true;
        if (raw.genius) note.genius = raw.genius;
        if (notes.length < MAX_NOTES_PER_LINE && !notes.some((n) => sameNote(n, note))) notes.push(note);
      }
      const result: LineResult = { ja: stripGlosses(ev.ja, u.text) };
      if (notes.length) result.notes = notes;
      this.record.lines[u.key] = result;
      this.added += 1;
      changed = true;
    }
    return changed;
  }
}

function outputBudget(expectedChars: number): number {
  // Japanese is ~1 token per character; the rest is room for the model's thinking.
  return Math.min(65_536, Math.max(8192, Math.round(expectedChars * 1.6) + 8000));
}

export async function translateSong(source: SongSource, record: SongRecord, options: TranslateOptions): Promise<TranslateOutcome> {
  const targets = missingLines(source, record);
  if (!targets.length) {
    delete record.stop;
    return { record, complete: true, model: record.model ?? '' };
  }
  const prompt = buildPrompt(source, record, targets);
  const builder = new RecordBuilder(source, record, targets.map((t) => t.uid));
  const parser = new ProtocolParser();
  let model = record.model ?? '';
  let stop: StopInfo | undefined;
  let finished = false;

  try {
    const result = await generateWithFallback(options.providers, {
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: outputBudget(prompt.expectedChars),
      thinking: options.thinking,
      onText: (chunk) => {
        if (builder.apply(parser.feed(chunk))) options.onUpdate?.(record);
        // Only translated lines count as progress: a stream that dies after the song
        // record alone lets the chain fall back to another model.
        return builder.added > 0;
      },
    }, { signal: options.signal, onStatus: options.onStatus, onAttempt: () => parser.reset() });
    if (builder.apply(parser.flush())) options.onUpdate?.(record);
    model = result.model;
    if (result.error) stop = stopFromError(result.error);
    else if (result.finish === 'length') stop = { reason: 'length', at: Date.now() };
    else if (result.finish === 'blocked') stop = { reason: 'blocked', at: Date.now() };
    finished = result.finish === 'stop';
  } catch (error) {
    if (!(error instanceof LLMError)) throw error;
    stop = stopFromError(error);
  }

  if (model) record.model = model;
  if (!missingLines(source, record).length) {
    delete record.stop;
    return { record, complete: true, model };
  }
  // Skipped lines ('gaps') only if the answer really ended; a stream that just went quiet
  // was cut, and reads "ここまで訳してあります" with 続きを訳す.
  const reason = !builder.added ? 'unusable' : finished || builder.ended ? 'gaps' : 'closed';
  record.stop = stop ?? { reason, at: Date.now() };
  return { record, complete: false, stop: record.stop, model };
}
