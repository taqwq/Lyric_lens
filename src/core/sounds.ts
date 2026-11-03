/*
 * Pure vocal sounds — oh, woah, yeah, ayy, la la — have no words to translate. A line made only
 * of them is not translated: the English right above already says all there is, and a katakana
 * echo (ウォー、オー) reads as noise. Its row is a quiet ♪ (ui/lines.ts). Inside a line with
 * words, the prompt keeps them in their own spelling (prompt.ts).
 *
 * The list is closed on purpose and holds only non-words: anything that can mean something
 * (hey, yo, who, nah, ho, ya, uh-oh, a lone "la") still goes to the model.
 */
const SOUND = new RegExp(`^(?:${[
  'o+h*', // o, oh, ooh, ohh
  'a+h+', // ah, aah, ahh
  'w+o+a*h*', 'w+h+o+a+h*', 'w+h+o{2,}h*', // wo, woo, woah, whoa, whoo (never who)
  'y+e+a+h*', 'y+e+h+', 'y+a+h+', 'y+u+h+', // yea, yeah, yeh, yah, yuh
  'a+y+e*', 'e+y+', 'e+h+', // ay, ayy, aye, ey, eh
  'h*u+h+', // uh, huh
  'h*m+', 'm+h+m+', // mm, hmm, mhm
  'h+a+(?:h+a+)*h*', // ha, haha, hah
  's+k+r+t*', 'b+r+t*', 'g+r+', // skrrt, brr, grr
].join('|')})$`);
/** Scat syllables count only as separate words, two or more on the line: a lone La is LA,
 *  and nana or dada is a word. */
const SCAT = /^(?:l+a+|n+a+|d+a+|d+o{2,})$/;
/** Pairs of sounds that say something: trouble (uh-oh, uh oh), no (uh-uh, mm-mm). A spaced
 *  "uh, uh" is filler and stays a sound. */
const MEANS = /\b(?:uh[\s,-]+oh|uh-uh|unh-unh|huh-uh|mm-mm|hmm-mm)\b/;

/** Every word of the line is a pure vocal sound ("Woah, woah", "(Yeah, yeah)", "La-la-la"). */
export function isSoundOnly(text: string): boolean {
  const line = text.normalize('NFKC').toLowerCase();
  // A question is never only sounds (Huh? Who? Yeah?).
  if (/[?？]/.test(line) || MEANS.test(line)) return false;
  const words = line.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  if (!words.length) return false;
  return words.every((w) => SOUND.test(w) || (words.length >= 2 && SCAT.test(w)));
}

/** A row that only repeats its English line ("Hey, hey" left as written, a Japanese line in an
 *  English song) says nothing the line above does not: its text is not drawn (ui/lines.ts shows
 *  a ♪ instead, or no row for a Japanese line). */
export function echoesLine(ja: string, text: string): boolean {
  const bare = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const b = bare(ja);
  return b !== '' && b === bare(text);
}
