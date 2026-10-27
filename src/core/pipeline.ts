/*
 * One tap, one request (docs/DESIGN.md §1, principle 2). The model reads the whole song,
 * writes the song record, then one record per distinct line, streamed. Whatever arrives is
 * applied (and saved by the caller) immediately. If the stream stops early, the song simply
 * stays partial with a reason; continuing is the reader's next tap, never automatic.
 */
import { locatePhrase } from '../genius/ranges';
import { generateWithFallback, nextPacificMidnight } from '../llm/chain';
import { LLMError } from '../llm/errors';
import { buildPrompt, noteBudget } from './prompt';
import { ProtocolParser, type ProtocolEvent } from './protocol';
import { headMatches, looseText, missingLines } from './song';
import type { LineResult, Note, SongRecord, SongSource, StopInfo } from './types';

const MAX_NOTES_PER_LINE = 3;

export interface TranslateOptions {
  apiKey: string;
  /** Scripts only: pin the models tried (see ChainOptions.onlyModels). */
  onlyModels?: string[];
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

/** Some models (Gemma in particular) write the source's ad-lib groups with ASCII
 *  parentheses and a space: 「そうさ (Yeah)」. The Japanese column uses one style, （…）,
 *  set tight against the text. The contents are left exactly as written. */
export function widenParens(ja: string): string {
  return ja.replace(/\s*\(([^()（）]*)\)/g, '（$1）');
}

const DEFINITION = /^[^。]*(?:のこと|の略語?|の一種|を(?:指す|意味する)(?:スラング|俗語|言葉|語|表現)?)。?$/;
/** A sentence that names two readings is wordplay, not a definition, whatever its ending. */
const TWO_READINGS = /両方|二重|二つの意味|掛け|掛詞|もじ|韻|同時に|裏の意味/;

const DEFINITION_TAIL = /(?:という意味)?(?:の表現)?(?:のこと|の略語?|の一種|を(?:指す|意味する)(?:スラング|俗語|言葉|語|表現)?)。?$/;
const GENERIC = new Set(['意味', '表現', '言葉', '俗語', '隠語', '略語', '略', '一種', '単語', '英語', '言い方', 'スラング']);

/** The words a definition sentence gives as the meaning: 「雪＝コカインを意味するスラング」 →
 *  コカイン, 「旅先でもらう日当のこと」 → 旅先, 日当. Kanji and katakana runs only. */
function definedTerms(sentence: string): string[] {
  const body = sentence.replace(DEFINITION_TAIL, '');
  const meaning = body.split(/[＝=]/).pop()!.replace(/^[^は]{1,24}は/, '');
  return (meaning.match(/[\u3400-\u9FFF々]+|[\u30A0-\u30FF]{2,}/g) ?? []).filter((t) => !GENERIC.has(t));
}

/** A slang/idiom note whose first sentence only defines the word repeats the translation
 *  when ja already renders that meaning (the prompt asks it to), and costs a ※. Then keep
 *  what follows the definition when there is something, or drop the note. When ja kept the
 *  word itself (「パルメザン」), the definition is what the reader needs: it stays. Reference,
 *  wordplay and ambiguous notes are never touched. Sentences are split without lookbehind
 *  (old iOS Safari). */
export function trimDefinition(note: Note, ja: string): Note | null {
  if (note.kind !== 'slang' && note.kind !== 'idiom') return note;
  const sentences = (note.text.match(/[^。]+。?/g) ?? []).map((s) => s.trim()).filter(Boolean);
  const first = sentences[0] ?? '';
  if (!DEFINITION.test(first) || TWO_READINGS.test(first)) return note;
  if (!definedTerms(first).some((t) => ja.includes(t))) return note;
  const rest = sentences.slice(1).join('');
  return rest.length >= 12 ? { ...note, text: rest } : null;
}

const PHRASE_JOIN = /\s*(?:[/／]|…|\.{3})\s*/;

/** Models sometimes quote separate words joined by '/' or '...' ("rights / write"), which
 *  never occurs in the line, so the note gets no underline (the phrase match needs one
 *  contiguous span). Such a phrase becomes the line's own text from the first quoted part
 *  to the last; if the parts are not all there in order, the longest part that is. A phrase
 *  that already matches (an "AC/DC" in the line itself) is kept as written. */
export function contiguousPhrase(phrase: string, line: string): string {
  if (!PHRASE_JOIN.test(phrase) || locatePhrase(line, phrase)) return phrase;
  const parts = phrase.split(new RegExp(PHRASE_JOIN.source, 'g')).map((p) => p.trim()).filter((p) => looseText(p));
  if (!parts.length) return phrase;
  let from = 0;
  let start = -1;
  for (const part of parts) {
    const at = locatePhrase(line.slice(from), part);
    if (!at) {
      start = -1;
      break;
    }
    if (start < 0) start = from + at.start;
    from += at.end;
  }
  if (start >= 0 && parts.length > 1) return line.slice(start, from).trim();
  const found = parts.filter((p) => locatePhrase(line, p)).sort((a, b) => b.length - a.length)[0];
  if (!found) return phrase;
  const at = locatePhrase(line, found)!;
  return line.slice(at.start, at.end).trim() || phrase;
}

function sameNote(a: Note, b: Note): boolean {
  return a.kind === b.kind && looseText(a.phrase) === looseText(b.phrase);
}

/** The preface's who is one short sentence: a parenthetical aside (setting, MV, career) is
 *  the model over-explaining, so it goes. If that would leave nothing, the original stays. */
export function tidyWho(who: string): string {
  return who.replace(/\s*[（(][^（）()]*[）)]/g, '').trim() || who;
}

/** The preface's what is at most two sentences. Without a 。 the text is one sentence. */
export function tidyWhat(what: string): string {
  return (what.match(/[^。]+。?/g) ?? [what]).slice(0, 2).join('');
}

export class RecordBuilder {
  private readonly targets: Set<number>;
  /** Notes this request may still add song-wide (the prompt states the same ceiling). */
  private notesLeft: number;
  /** Extra notes allowed beyond the ceiling, for wordplay and ambiguous readings only. */
  private bonusLeft = 2;
  /** Distinct lines accepted in this request. */
  added = 0;
  /** Line records dropped because their echoed first words did not match the line. */
  misaligned = 0;
  /** The model wrote its {"t":"end"} record. */
  ended = false;

  constructor(private readonly source: SongSource, readonly record: SongRecord, targets: number[]) {
    this.targets = new Set(targets);
    this.notesLeft = noteBudget(targets.length);
  }

  apply(events: ProtocolEvent[]): boolean {
    let changed = false;
    for (const ev of events) {
      if (ev.type === 'song') {
        if (this.record.song?.who && this.record.song.what) continue;
        this.record.song = { who: tidyWho(ev.who), what: tidyWhat(ev.what), ...(ev.tone ? { tone: ev.tone } : {}), ...(ev.motifs ? { motifs: ev.motifs } : {}) };
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
        const built: Note = { kind: raw.kind, phrase: contiguousPhrase(raw.phrase, u.text), text: raw.text };
        if (raw.conjecture) built.conjecture = true;
        if (raw.genius) built.genius = raw.genius;
        // A dropped definition does not use up a slot of the cap.
        const note = trimDefinition(built, ev.ja);
        if (!note) continue;
        if (notes.length >= MAX_NOTES_PER_LINE || notes.some((n) => sameNote(n, note))) continue;
        // Over the song-wide ceiling only wordplay and ambiguous notes (the prompt's top
        // priorities) still get in, a few of them.
        if (this.notesLeft > 0) this.notesLeft -= 1;
        else if ((note.kind === 'wordplay' || note.kind === 'ambiguous') && this.bonusLeft > 0) this.bonusLeft -= 1;
        else continue;
        notes.push(note);
      }
      const result: LineResult = { ja: widenParens(stripGlosses(ev.ja, u.text)) };
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
    const result = await generateWithFallback(options.apiKey, {
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: outputBudget(prompt.expectedChars),
      onText: (chunk) => {
        if (builder.apply(parser.feed(chunk))) options.onUpdate?.(record);
        // Only translated lines count as progress: a stream that dies after the song
        // record alone lets the chain fall back to another model.
        return builder.added > 0;
      },
    }, { signal: options.signal, onStatus: options.onStatus, onAttempt: () => parser.reset(), onlyModels: options.onlyModels });
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
