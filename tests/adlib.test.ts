import './setup';
import { describe, expect, it } from 'vitest';
import { dropSoundWords, splitAdlibs, visibleJa } from '../src/core/adlib';

describe('splitAdlibs', () => {
  it('leaves a line whose source has no parentheses whole', () => {
    expect(splitAdlibs('座ってろ（待てよ）', 'Sit down')).toEqual({ main: '座ってろ（待てよ）', tail: '' });
  });

  it('splits trailing groups that mirror trailing source ad-libs', () => {
    expect(splitAdlibs('座ってろ（待てよ、クソガキ）', "Sit down (Hold up, lil' bitch)")).toEqual({ main: '座ってろ', tail: '（待てよ、クソガキ）' });
    expect(splitAdlibs('マンマンに偉そうなのは誰だ？（マンマン）', 'Who frontin on Man-Man? (Man-Man)')).toEqual({ main: 'マンマンに偉そうなのは誰だ？', tail: '（マンマン）' });
  });

  it('keeps a line that is only an ad-lib whole', () => {
    expect(splitAdlibs('（待てよ）', "(Hol' up)")).toEqual({ main: '（待てよ）', tail: '' });
  });

  it('does nothing when the source has parentheses mid-line', () => {
    expect(splitAdlibs('（ああ）行くぞ（今）', '(Yeah) let us go (now) right')).toEqual({ main: '（ああ）行くぞ（今）', tail: '' });
  });

  it('only splits: which groups are shown is decided by visibleJa', () => {
    expect(splitAdlibs('そういう気分だ（Yeah, yeah）', "That's just how I feel (Yeah, yeah)")).toEqual({ main: 'そういう気分だ', tail: '（Yeah, yeah）' });
  });
});

describe('dropSoundWords', () => {
  it.each([
    ['Ayy、マジでイカれてる、ayy、お前には驚かねえ、ayy', 'マジでイカれてる、お前には驚かねえ'],
    ['自重することもあるが、たまにはかますぜ、yeah', '自重することもあるが、たまにはかますぜ'],
    ['Oh, yeah、君が必要なんだ', '君が必要なんだ'],
    ['行くぜ、ayy！', '行くぜ！'],
    ['神として名を残すかもな（Yeah、待てよ）', '神として名を残すかもな（待てよ）'],
    ['一緒に乗れよ（yeah, yeah）', '一緒に乗れよ'],
    ['あいつは浅はかだが アソコは深い（あいつは浅はか） yeah, ayy', 'あいつは浅はかだが アソコは深い（あいつは浅はか）'],
    ['Uh-huh、そうさ', 'そうさ'],
    ['Yeah（待てよ）', '（待てよ）'],
    // a mark after a sound that opens the row or a group goes with it
    ['Ayy！シーンに乗りつけろ', 'シーンに乗りつけろ'],
    ['（Ayy！待てよ）', '（待てよ）'],
    ['Yeah…、行こうぜ', '行こうぜ'],
    // after a phrase it ends that phrase
    ['待て、Ayy！行くぜ', '待て！行くぜ'],
    ['金がある、ayy（ボス）', '金がある（ボス）'],
    // a sound right after a phrase's end mark or a group
    ['ビッチ！ayy', 'ビッチ！'],
    ['ビッチ。Ayy', 'ビッチ。'],
    ['待てよ（待てよ）ayy', '待てよ（待てよ）'],
  ])('%s → %s', (ja, want) => {
    expect(dropSoundWords(ja)).toBe(want);
  });

  it.each([
    '「Yeah」と答えた', // a quoted answer is a word
    'Huh？何だよ', // so is a sound asked as a question
    'Yeah? 本気か',
    '俺はyeahって言った', // and one that touches kana
    'O2アリーナをO3に変えてやるぜ', // a letter beside a digit is a name
    'LAの夜、TEDトークだ',
    'Hey、yeah', // a run with a word in it stays whole
    '銃に弾を込めて、浴びせてやるぜ（Bop, bop, bop）', // a sound effect outside the list
    'ひとりで歩く',
  ])('leaves %s alone', (ja) => {
    expect(dropSoundWords(ja)).toBe(ja);
  });
});

describe('visibleJa', () => {
  it('is empty for a row that only repeats its English line or holds nothing but sounds', () => {
    expect(visibleJa('Hey, hey', 'Hey, hey')).toBe('');
    expect(visibleJa('Yeah, yeah', 'Yeah, yeah, I know')).toBe('');
  });

  it('otherwise is the translation without its sounds', () => {
    expect(visibleJa('Ayy、金がどんどん入ってくる、ayy', "Money keep comin' in, ayy")).toBe('金がどんどん入ってくる');
  });

  it('drops a trailing group made only of sounds, whatever the edition stored', () => {
    expect(visibleJa('そういう気分だ（イェー、イェー）', "That's just how I feel (Yeah, yeah)")).toBe('そういう気分だ');
    expect(visibleJa('そういう気分だ（Yeah, yeah）', "That's just how I feel (Yeah, yeah)")).toBe('そういう気分だ');
    // pairs by position: only the group of sounds goes; a group with words stays, without its sounds
    expect(visibleJa('座れ（イェー）（待てよ）', 'Sit down (yeah) (hold up)')).toBe('座れ（待てよ）');
    expect(visibleJa('神として名を残すかもな（Yeah、待てよ）', 'Might go down a G-O-D (Yeah, wait)')).toBe('神として名を残すかもな（待てよ）');
    // groups are paired before the Latin sounds go, so a row that mixes both still pairs
    expect(visibleJa('座れ（yeah）（イェー）', 'Sit down (yeah) (yeah)')).toBe('座れ');
  });

  it('leaves the groups alone when their count does not match the English', () => {
    expect(visibleJa('座れ（イェー、待てよ）', 'Sit down (yeah) (hold up)')).toBe('座れ（イェー、待てよ）');
  });
});
