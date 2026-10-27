/* Data model shared by the engine, storage and the page. See docs/DESIGN.md §8. */

export type NoteKind = 'slang' | 'wordplay' | 'reference' | 'idiom' | 'ambiguous';

export const NOTE_KINDS: readonly NoteKind[] = ['slang', 'wordplay', 'reference', 'idiom', 'ambiguous'];

export const NOTE_LABELS: Record<NoteKind, string> = {
  slang: 'スラング',
  wordplay: '掛詞',
  reference: '引用・元ネタ',
  idiom: '慣用句',
  ambiguous: '二通りに読める',
};

export interface Note {
  kind: NoteKind;
  /** Exact phrase quoted from the original line. */
  phrase: string;
  /** Japanese explanation, at most two short sentences. */
  text: string;
  /** The model flagged this as conjecture. */
  conjecture?: boolean;
  /** Id of the Genius annotation the note drew on. */
  genius?: string;
}

export interface LineResult {
  ja: string;
  notes?: Note[];
}

/** What the model grasped about the whole song before translating. */
export interface SongContext {
  /** Who speaks to whom (誰が誰に). */
  who: string;
  /** What the song is doing (この曲は). */
  what: string;
  /** Kept for resume consistency; not shown. */
  tone?: string;
  motifs?: Array<{ en: string; ja: string }>;
}

export interface GeniusAnnotation {
  id: string;
  /** The annotated lyric fragment. */
  fragment: string;
  text: string;
  votes: number;
  /** Written or confirmed by the artist or a verified Genius editor. */
  verified?: boolean;
}

export interface SongMeta {
  title: string;
  artist: string;
  album?: string;
  /** Genius' own "About" text: background for the model, never shown verbatim. */
  about?: string;
  /** Genius community annotations: grounding for notes, shown collapsed inside them. */
  annotations?: GeniusAnnotation[];
}

/** One rendered lyric line on the page (every occurrence, in reading order). */
export interface LyricLine {
  index: number;
  text: string;
  /** Normalized text; identical keys are exact repeats and share one translation. */
  key: string;
  /** 1-based id of the distinct line this occurrence belongs to. */
  uid: number;
  /** 0 for the first occurrence of its text, 1 for the next repeat, … */
  occurrence: number;
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

/** Why a song stopped before every line was translated (docs/DESIGN.md §3, seams). */
export type StopReason =
  | 'busy' | 'rate' | 'quota' | 'auth' | 'blocked' | 'network'
  | 'rejected' | 'no-model' | 'empty' | 'unusable' | 'stopped' | 'length' | 'closed' | 'gaps';

export interface StopInfo {
  reason: StopReason;
  at: number;
  /** For rate/quota: when trying again makes sense. */
  until?: number;
  /** The failure behind it (task: 直近のエラー); absent on older records and on plain closes. */
  detail?: StopDetail;
}

export interface StopDetail {
  kind: string;
  model: string;
  status: number;
  /** At most 200 characters, with any API key scrubbed. */
  text: string;
}

/** What is persisted per song. Lines are keyed by normalized text, so a Genius edit
 *  to one line leaves every other translation in place. */
export interface SongRecord {
  v: 2;
  /** Song identity: Genius song id when known, else the canonical path. */
  id: string;
  path: string;
  title: string;
  artist: string;
  song?: SongContext;
  lines: Record<string, LineResult>;
  stop?: StopInfo;
  model?: string;
  createdAt: number;
  updatedAt: number;
}
