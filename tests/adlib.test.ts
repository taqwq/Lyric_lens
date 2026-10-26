import './setup';
import { describe, expect, it } from 'vitest';
import { splitAdlibs } from '../src/core/adlib';

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
});
