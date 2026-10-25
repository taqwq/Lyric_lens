import './setup';
import { describe, expect, it } from 'vitest';
import { extractLyrics } from '../src/genius/extract';
import { locatePhrase, phrasePattern, phraseRange } from '../src/genius/ranges';

function page(html: string): Document {
  document.body.innerHTML = `<div data-lyrics-container="true">${html}</div>`;
  return document;
}

describe('locatePhrase', () => {
  it('matches with curly vs straight quotes, case and extra spaces', () => {
    expect(locatePhrase("Finesse a nigga with some counterfeits, but now I'm countin' this", 'now I’m COUNTIN’')).toEqual({ start: 44, end: 59 }); // trailing quote trimmed
    expect(locatePhrase('Pull up on your  block, then break it down', 'your block')).toEqual({ start: 11, end: 22 });
  });

  it('ignores surrounding quotes and punctuation in the quoted phrase', () => {
    expect(locatePhrase('Soprano C, we like to keep it on a high note', '"Soprano C,"')).toEqual({ start: 0, end: 9 });
  });

  it('returns null when absent', () => {
    expect(locatePhrase('Sit down', 'be humble')).toBeNull();
    expect(phrasePattern('   ')).toBeNull();
  });

  it('escapes regex characters', () => {
    expect(locatePhrase('Is it (really) $5?', '(really) $5')).toEqual({ start: 6, end: 17 });
  });
});

describe('phraseRange', () => {
  it('spans text split across annotation markup', () => {
    const doc = page('Parmesan where my <a href="/x"><span>accountant lives</span></a>, in fact<br>next');
    const ex = extractLyrics(doc)!;
    const range = phraseRange(ex.texts[0], 'my accountant', doc)!;
    expect(range).not.toBeNull();
    expect(range.toString()).toBe('my accountant');
    expect(range.startContainer.textContent).toBe('Parmesan where my ');
    expect(range.endContainer.textContent).toBe('accountant lives');
  });

  it('finds a phrase that ends exactly at a node boundary', () => {
    const doc = page('<a href="/y"><span>taste bloods</span></a>?<br>');
    const ex = extractLyrics(doc)!;
    expect(phraseRange(ex.texts[0], 'taste bloods', doc)?.toString()).toBe('taste bloods');
  });

  it('gives null when the text nodes were replaced (Genius re-render)', () => {
    const doc = page('Sit down, be humble<br>');
    const ex = extractLyrics(doc)!;
    doc.querySelector('[data-lyrics-container]')!.innerHTML = 'Sit down, be humble<br>';
    expect(phraseRange(ex.texts[0], 'be humble', doc)).toBeNull();
  });
});

describe('locatePhrase: ellipses and dropped g', () => {
  it('matches an ellipsis written either way', () => {
    expect(locatePhrase('Wait… what did you say', 'wait... what')).toEqual({ start: 0, end: 10 });
    expect(locatePhrase('Wait... what did you say', 'Wait… what')).toEqual({ start: 0, end: 12 });
  });

  it("matches nothing / nothin' / nothin", () => {
    expect(locatePhrase("I ain't sayin' nothin' new", 'nothing new')).toEqual({ start: 15, end: 26 });
    expect(locatePhrase('I keep running', "keep runnin'")).toEqual({ start: 2, end: 14 });
  });
});
