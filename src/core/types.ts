/* Data model shared by the pipeline, storage and UI. */

export type NoteKind = 'slang' | 'wordplay' | 'reference' | 'idiom' | 'ambiguity';

export const NOTE_KINDS: readonly NoteKind[] = ['slang', 'wordplay', 'reference', 'idiom', 'ambiguity'];

export const NOTE_LABELS: Record<NoteKind, string> = {
  slang: 'スラング',
  wordplay: '言葉遊び',
  reference: '背景',
  idiom: '慣用句',
  ambiguity: '二通りの読み',
};

export interface Note {
  kind: NoteKind;
  /** Phrase from the original line the note is about. */
  span: string;
  /** Explanation in Japanese. */
  text: string;
  /** The model marked the note as a conjecture rather than established fact. */
  unsure?: boolean;
}

export interface LineResult {
  ja: string;
  notes?: Note[];
}

export interface SongContext {
  /** What the song is doing, 2–3 sentences. */
  about: string;
  /** Who is speaking to whom. */
  voice: string;
}

export interface SongMeta {
  title: string;
  artist: string;
  album?: string;
  /** Genius' own "About" text: background for the model, never shown verbatim. */
  about?: string;
}

/** One rendered lyric line on the page (every occurrence, in reading order). */
export interface LyricLine {
  index: number;
  text: string;
  /** Normalized text; identical keys share a translation (repeated hooks stay consistent). */
  key: string;
  /** 1-based id of the unique line this occurrence belongs to. */
  uid: number;
  section: number;
}

export interface Section {
  index: number;
  /** Header as written on Genius, e.g. "[Chorus: Artist]"; null for unlabeled lyrics. */
  label: string | null;
}

export interface UniqueLine {
  uid: number;
  key: string;
  text: string;
  occurrences: number;
}

export interface SongSource {
  meta: SongMeta;
  sections: Section[];
  lines: LyricLine[];
  unique: UniqueLine[];
}

/** What is persisted per song. Lines are keyed by normalized text, so a Genius edit
 *  to one line invalidates only that line rather than the whole song. */
export interface SongRecord {
  v: 1;
  path: string;
  title: string;
  artist: string;
  context?: SongContext;
  lines: Record<string, LineResult>;
  model?: string;
  createdAt: number;
  updatedAt: number;
}
