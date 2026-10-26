/*
 * Trailing ad-libs and echoes — "Sit down (Hold up, bitch)" — are kept in the translation as
 * （…） groups in the same place. Splitting them off lets the page set them in a quieter ink so
 * the eye lands on the line itself, as it does when the line is rapped.
 */
const GROUP = '[（(][^（）()]{1,48}[）)]';
const TRAILING_GROUPS = new RegExp(`(?:\\s*${GROUP})+\\s*$`);
/** The English line's parentheses are all at its end. */
const SOURCE_TRAILING_ONLY = /^[^(（]*(?:[(（][^()（）]*[)）]\s*)+$/;

export function splitAdlibs(ja: string, source: string): { main: string; tail: string } {
  if (!/[(（]/.test(source) || !SOURCE_TRAILING_ONLY.test(source.trim())) return { main: ja, tail: '' };
  const m = TRAILING_GROUPS.exec(ja);
  // A line that is nothing but an ad-lib stays whole: there is no "main" to bring forward.
  if (!m || !ja.slice(0, m.index).trim()) return { main: ja, tail: '' };
  return { main: ja.slice(0, m.index), tail: m[0] };
}
