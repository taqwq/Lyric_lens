import { describe, expect, it } from 'vitest';
import { echoesLine, isSoundOnly } from '../src/core/sounds';

describe('isSoundOnly', () => {
  it.each([
    'Woah, woah', 'Whoa', 'Wooah', 'Woo!', 'Oh, oh, oh', 'Ooh-ooh', 'Ohhh', 'Oh (Woah)', 'Ah', 'Aah',
    '(Yeah, yeah)', 'Yeah', 'Yeahhh', 'Yea', 'Yeh', 'Yuh', 'Yah', 'OH, YEAH',
    'Ayy', 'Ay, ay, ay', 'Aye', 'Eyy', 'Eh', 'Uh', 'Huh', 'Uh-huh', 'Mm-hmm',
    'Mm', 'Mmm', 'Hmm', 'Mhm', 'Ha-ha', 'Hahaha', 'Uh, uh',
    'La-la-la', 'Na, na, na', 'Na-na-na, la-la-la', 'Da-da-da', 'Doo-doo', 'Oh, la', 'Skrrt', 'Skrrt, skrrt (Brr)', 'Brr', 'Grr',
  ])('%s is only sounds', (text) => {
    expect(isSoundOnly(text)).toBe(true);
  });

  it.each([
    'Oh no', 'Oh my God', 'Oh, baby', 'Yeah, I know', 'Woah, slow down', 'No, no, no', 'Yeah (Hold up)',
    // words that can mean something are never sounds
    'Hey', 'Hey, hey', 'Yo', 'Nah', 'Ho', 'Ya', 'Baby', 'Aha', 'Ooh-wee', 'L.A.', 'Uh, 2x',
    'Who', 'Who?', 'Uh-oh', 'Uh oh', 'Uh, oh', 'Uh-uh', 'Mm-mm', 'Unh-unh', 'Huh-uh', 'Hmm-mm',
    // a question is never only sounds
    'Huh?', 'Yeah?', 'Oh?', 'Hm？',
    // a lone scat syllable is a word (LA, no, the), and so is a fused one (grandma, a name, dad)
    'La', 'LA', 'Na', 'Da', 'Nana', 'Lala', 'Dada',
    // no words at all, or not Latin
    '...', '!', '', 'ああ',
  ])('%s says something', (text) => {
    expect(isSoundOnly(text)).toBe(false);
  });
});

describe('echoesLine', () => {
  it('is a row that only repeats its English line', () => {
    expect(echoesLine('Hey, hey', 'Hey, hey!')).toBe(true);
    expect(echoesLine('YO YO', 'Yo, yo')).toBe(true);
    expect(echoesLine('ありがとう', 'ありがとう')).toBe(true);
  });

  it('is not a translation, nor an empty row', () => {
    expect(echoesLine('おい、おい', 'Hey, hey')).toBe(false);
    expect(echoesLine('グッチ、グッチ', 'Gucci, Gucci')).toBe(false);
    expect(echoesLine('…', '...')).toBe(false);
  });
});
