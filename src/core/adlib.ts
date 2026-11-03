import { echoesLine, isSoundOnly } from './sounds';

/*
 * Trailing ad-libs and echoes — "Sit down (Hold up, bitch)" — are kept in the translation as
 * （…） groups in the same place. Splitting them off lets the page set them in a quieter ink so
 * the eye lands on the line itself, as it does when the line is rapped.
 *
 * Sounds are left to the English line above: the Japanese row carries the meaning. The prompt
 * asks for them in their own spelling (never katakana, never a word), and the page takes them
 * out — a group of sounds alone, (Yeah, yeah), and the ayy between the phrases of a row.
 */
const GROUP = '[（(][^（）()]{1,48}[）)]';
const TRAILING_GROUPS = new RegExp(`(?:\\s*${GROUP})+\\s*$`);
const EACH_GROUP = new RegExp(`\\s*${GROUP}`, 'g');
/** The English line's parentheses are all at its end. */
const SOURCE_TRAILING_ONLY = /^[^(（]*(?:[(（][^()（）]*[)）]\s*)+$/;
/** Latin words standing at the row's edges, between separators, after a phrase's end mark or
 *  inside brackets, with the ！ or … that may follow them. One that touches kana or a quote mark
 *  is used as a word (「Yeah」と答えた, 俺はyeahって), and one that touches a digit is part of a
 *  name (O2). */
const LATIN_RUN = /(?<=^|[、,，\s（(。！？!?…）)])([A-Za-z][A-Za-z'’]*(?:(?:[ ,、，]+|-)[A-Za-z][A-Za-z'’]*)*)(?:([！!。…]+)|(?=$|[、,，\s（()）？?]))/g;

/** What the page shows for a stored translation: nothing when it only repeats its English line,
 *  otherwise the translation without its sounds. Groups are paired with the English before any
 *  word inside them goes, so the counts still agree. */
export function visibleJa(ja: string, source: string): string {
  return echoesLine(ja, source) ? '' : dropSoundWords(dropSoundGroups(ja, source));
}

/** 「Ayy、マジでイカれてる、ayy」 → 「マジでイカれてる」, tidying the separators the sounds leave.
 *  A sound asked as a question (Huh？) is a word and stays. */
export function dropSoundWords(ja: string): string {
  const out = ja.replace(LATIN_RUN, (whole: string, run: string, marks: string | undefined, at: number) => {
    if (run.length < 2 || /[?？]/.test(ja[at + whole.length] ?? '') || !isSoundOnly(run)) return whole;
    // A ！ after a sound that opens the row or a group goes with it; after a phrase it ends that phrase.
    const opens = at === 0 || /[（(。！？!?…]/.test(ja[at - 1]!);
    return marks && !opens ? marks : '';
  });
  if (out === ja) return ja;
  return out
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/([、,，])(?:\s*[、,，])+/g, '$1')
    .replace(/(^|[（(])\s*[、,，]\s*/g, '$1')
    .replace(/\s*[、,，]\s*(?=$|[（()）。！？!?…])/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function splitAdlibs(ja: string, source: string): { main: string; tail: string } {
  if (!/[(（]/.test(source) || !SOURCE_TRAILING_ONLY.test(source.trim())) return { main: ja, tail: '' };
  const m = TRAILING_GROUPS.exec(ja);
  // A line that is nothing but an ad-lib stays whole: there is no "main" to bring forward.
  if (!m || !ja.slice(0, m.index).trim()) return { main: ja, tail: '' };
  return { main: ja.slice(0, m.index), tail: m[0] };
}

/** Drops the trailing groups that are only sounds, whatever an edition stored for them (older
 *  ones wrote （イェー、イェー）). Groups pair up by position, so only when the counts agree. */
function dropSoundGroups(ja: string, source: string): string {
  const { main, tail } = splitAdlibs(ja, source);
  if (!tail) return ja;
  const english = [...source.matchAll(/[(（]([^()（）]*)[)）]/g)].map((g) => g[1]!);
  if (english.length !== (tail.match(EACH_GROUP) ?? []).length) return ja;
  let i = 0;
  return main + tail.replace(EACH_GROUP, (group) => (isSoundOnly(english[i++]!) ? '' : group));
}
