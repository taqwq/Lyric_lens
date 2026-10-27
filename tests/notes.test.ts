import './setup';
import { describe, expect, it, vi } from 'vitest';
import type { GeniusAnnotation, Note } from '../src/core/types';
import { geniusFor, NoteView, type OpenNote } from '../src/ui/notes';

const ann = (id: string, fragment: string, votes = 1, verified = false): GeniusAnnotation => ({ id, fragment, text: `about ${fragment}`, votes, ...(verified ? { verified } : {}) });
const note = (phrase: string, genius?: string): Note => ({ kind: 'reference', phrase, text: '説明', ...(genius ? { genius } : {}) });

const annotations = [
  ann('11592548', "Who that nigga thinkin' that he frontin' on Man-Man? (Man-Man)", 50),
  ann('11592600', "Get the fuck off my stage, I'm the Sandman (Sandman)", 120),
  ann('11592601', 'Sandman', 3),
];

describe('geniusFor', () => {
  it('keeps a cited annotation that is about the phrase', () => {
    expect(geniusFor(note('Man-Man', '11592548'), annotations)).toEqual({ annotation: annotations[0], cited: true });
  });

  it('rejects a citation of a neighbouring line and falls back to the best overlapping annotation', () => {
    const line = "Get the fuck off my stage, I'm the Sandman (Sandman)";
    const result = geniusFor(note('Sandman', '11592548'), annotations, line);
    expect(result?.cited).toBe(false);
    expect(result?.annotation.id).toBe('11592600');
  });

  it('accepts a citation whose fragment is the whole line containing the phrase', () => {
    const line = "Get the fuck off my stage, I'm the Sandman (Sandman)";
    expect(geniusFor(note('my stage', '11592600'), annotations, line)?.cited).toBe(true);
  });

  it('returns null without annotations or any overlap', () => {
    expect(geniusFor(note('Parmesan'), null)).toBeNull();
    expect(geniusFor(note('Parmesan'), annotations)).toBeNull();
  });

  it('prefers verified annotations', () => {
    const list = [ann('a', 'Sandman here', 90), ann('b', 'the Sandman here', 5, true)];
    expect(geniusFor(note('Sandman'), list)?.annotation.id).toBe('b');
  });
});

function openNote(notes: Note[], annotations: GeniusAnnotation[] | null, onClose = vi.fn()) {
  document.body.innerHTML = '<span id="line">Sandman</span>';
  const lineNode = document.getElementById('line')!;
  const view = new NoteView();
  const open: OpenNote = { index: 0, key: 'k', lineNode, result: { ja: 'x', notes }, lineText: undefined, annotations };
  view.open(open, onClose);
  return { view, el: view.element!, onClose };
}

describe('NoteView DOM', () => {
  const n: Note = { kind: 'reference', phrase: 'Sandman', text: '説明です', genius: '11592601', conjecture: true };
  const long = { ...ann('11592601', 'Sandman', 312), text: 'x'.repeat(500) };

  it('writes the phrase, bracketed kind and conjecture as literal text', () => {
    const { el } = openNote([n], [ann('11592601', 'Sandman', 312)]);
    expect(el.getAttribute('role')).toBe('note');
    const head = el.querySelector('p.ll-note-head')!;
    // The phrase is plain, as the highlight on the lyric line above it is: no quotation marks.
    expect(head.querySelector('.ll-note-phrase')!.textContent).toBe('Sandman');
    expect(head.querySelector('.ll-note-kind')!.textContent).toBe('〔引用・元ネタ〕');
    expect(head.querySelector('.ll-note-conj')!.textContent).toBe('〔推測〕');
    expect(el.querySelector('p.ll-note-text')!.textContent).toBe('説明です');
    expect(el.querySelector('p.ll-note-src')!.textContent).toBe('Genius注釈より');
    expect(el.querySelector('.ll-note-body')).toBeNull();
  });

  it('has no conjecture mark or source line when neither applies', () => {
    const { el } = openNote([{ kind: 'slang', phrase: 'Sandman', text: 't' }], [ann('1', 'Sandman')]);
    expect(el.querySelector('.ll-note-conj')).toBeNull();
    expect(el.querySelector('.ll-note-src')).toBeNull();
  });

  it('Genius disclosure: label, votes span, たたむ ▴ when open', () => {
    const { el } = openNote([n], [long]);
    const toggle = el.querySelector<HTMLButtonElement>('.ll-gn-toggle')!;
    const body = el.querySelector<HTMLElement>('.ll-gn-text')!;
    expect(toggle.textContent).toBe('Geniusの注釈を英語で読む ▾');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.ll-gn-votes')!.textContent).toBe('▲312');
    expect(body.hidden).toBe(true);
    toggle.click();
    expect(toggle.textContent).toBe('たたむ ▴');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    body.querySelector<HTMLButtonElement>('.ll-gn-more')!.click();
    expect(body.querySelector('.ll-gn-more')).toBeNull();
    toggle.click();
    expect(toggle.textContent).toBe('Geniusの注釈を英語で読む ▾');
    expect(body.hidden).toBe(true);
  });

  it('注を閉じる shows only while an annotation is expanded and calls onClose', () => {
    const { el, onClose } = openNote([n], [long]);
    const close = el.querySelector<HTMLButtonElement>('.ll-note-close')!;
    expect(close.textContent).toBe('注を閉じる');
    expect(close.hidden).toBe(true);
    const toggle = el.querySelector<HTMLButtonElement>('.ll-gn-toggle')!;
    toggle.click();
    expect(close.hidden).toBe(false);
    close.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    toggle.click();
    expect(close.hidden).toBe(true);
  });

  it('注を閉じる stays hidden when there is no Genius annotation', () => {
    const { el } = openNote([{ kind: 'slang', phrase: 'zzz', text: 't' }], null);
    expect(el.querySelector('.ll-gn')).toBeNull();
    expect(el.querySelector<HTMLElement>('.ll-note-close')!.hidden).toBe(true);
  });
});
