/*
 * Notes open inline under their line, one at a time (docs/DESIGN.md §5). While a note is
 * open, its English phrase is underlined with the CSS Custom Highlight API: Genius' text
 * nodes are never wrapped or edited. Hovering ※ (desktop) previews the underline.
 */
import { looseText } from '../core/song';
import { NOTE_LABELS, type GeniusAnnotation, type LineResult, type Note } from '../core/types';
import type { LineText } from '../genius/extract';
import { phraseRange } from '../genius/ranges';
import { h, isolateClicks } from './dom';

const GENIUS_CLIP = 400;
const GN_LABEL = 'Geniusの注釈を英語で読む ▾';

interface HighlightRegistry { set(name: string, value: unknown): void; delete(name: string): void }
declare const Highlight: { new (...ranges: Range[]): unknown } | undefined;

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights && typeof Highlight !== 'undefined' ? css.highlights : null;
}

function paint(name: string, ranges: Range[]): void {
  const reg = registry();
  if (!reg) return;
  if (!ranges.length || typeof Highlight === 'undefined') reg.delete(name);
  else reg.set(name, new Highlight(...ranges));
}

export function phraseRanges(lineText: LineText | undefined, notes: Note[]): Range[] {
  return notes.map((n) => phraseRange(lineText, n.phrase)).filter((r): r is Range => Boolean(r));
}

function overlaps(fragment: string, text: string): boolean {
  const f = looseText(fragment);
  const t = looseText(text);
  return Boolean(f && t) && (f.includes(t) || (f.length > 6 && t.includes(f)));
}

/** The Genius annotation to show next to a note: the one it cites, if that annotation is
 *  really about this line (models sometimes cite a neighbour's id); otherwise the
 *  highest-voted annotation whose fragment overlaps the quoted phrase. */
export function geniusFor(note: Note, annotations: GeniusAnnotation[] | null, lineText = ''): { annotation: GeniusAnnotation; cited: boolean } | null {
  if (!annotations?.length) return null;
  const cited = note.genius ? annotations.find((a) => a.id === note.genius) : undefined;
  if (cited && (overlaps(cited.fragment, note.phrase) || (lineText && overlaps(cited.fragment, lineText)))) return { annotation: cited, cited: true };
  const best = annotations
    .filter((a) => overlaps(a.fragment, note.phrase))
    .sort((a, b) => b.votes + (b.verified ? 100 : 0) - (a.votes + (a.verified ? 100 : 0)))[0];
  return best ? { annotation: best, cited: false } : null;
}

export interface OpenNote {
  index: number;
  /** Line key: lets the note follow its line when indexes shift. */
  key: string;
  /** Node of the line the note belongs under. */
  lineNode: HTMLElement;
  result: LineResult;
  lineText: LineText | undefined;
  annotations: GeniusAnnotation[] | null;
}

export class NoteView {
  private el: HTMLElement | null = null;
  private current: OpenNote | null = null;

  get openIndex(): number | null {
    return this.current?.index ?? null;
  }

  get state(): Readonly<OpenNote> | null {
    return this.current;
  }

  get element(): HTMLElement | null {
    return this.el;
  }

  /** `animate`: the reader opened it (not a re-render refreshing an open note). */
  open(note: OpenNote, onClose: () => void, animate = false): void {
    this.close();
    this.current = note;
    const notes = note.result.notes ?? [];
    // 注を閉じる appears only while a Genius annotation is unfolded (a long read worth leaving).
    const sync = () => { closeButton.hidden = !el.querySelector('.ll-gn-toggle[aria-expanded="true"]'); };
    const closeButton: HTMLButtonElement = h('button', { class: 'll-note-close', type: 'button', hidden: true, onclick: () => onClose() }, '注を閉じる');
    const el = h('div', { class: 'll-note', lang: 'ja', role: 'note', 'data-exclude-from-selection': 'true' },
      ...notes.map((n) => this.item(n, note.annotations, note.lineText?.raw ?? '', sync)), closeButton);
    isolateClicks(el);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    });
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.dataset.enter = '';
      // Also on a timer: a background tab may never fire animationend, and a node moved by
      // reattach() with the attribute still set would replay the animation.
      const done = () => { delete el.dataset.enter; };
      el.addEventListener('animationend', done, { once: true });
      setTimeout(done, 400);
    }
    note.lineNode.after(el);
    this.el = el;
    paint('ll-phrase', phraseRanges(note.lineText, notes));
  }

  /** Re-attaches after a re-render replaced the line node or Genius re-rendered text. */
  reattach(lineNode: HTMLElement | undefined, lineText: LineText | undefined): void {
    if (!this.el || !this.current || !lineNode) return;
    if (lineNode.nextSibling !== this.el) lineNode.after(this.el);
    this.current = { ...this.current, lineNode, lineText };
    paint('ll-phrase', phraseRanges(lineText, this.current.result.notes ?? []));
  }

  close(): void {
    this.el?.remove();
    this.el = null;
    this.current = null;
    paint('ll-phrase', []);
  }

  /** Desktop hover on ※: preview which words the note is about. */
  peek(lineText: LineText | undefined, notes: Note[] | null): void {
    paint('ll-phrase-peek', notes ? phraseRanges(lineText, notes) : []);
  }

  private item(note: Note, annotations: GeniusAnnotation[] | null, lineText: string, onToggle: () => void): HTMLElement {
    const match = geniusFor(note, annotations, lineText);
    const genius = match?.annotation ?? null;
    const cited = Boolean(match?.cited);
    return h('div', { class: 'll-note-item' },
      h('p', { class: 'll-note-head' },
        h('span', { class: 'll-note-phrase', lang: 'en' }, `“${note.phrase}”`),
        h('span', { class: 'll-note-kind' }, `〔${NOTE_LABELS[note.kind]}〕`),
        note.conjecture ? h('span', { class: 'll-note-conj' }, '〔推測〕') : null,
      ),
      h('p', { class: 'll-note-text' }, note.text),
      cited ? h('p', { class: 'll-note-src' }, 'Genius注釈より') : null,
      genius ? this.geniusBlock(genius, onToggle) : null,
    );
  }

  private geniusBlock(a: GeniusAnnotation, onToggle: () => void): HTMLElement {
    const body = h('div', { class: 'll-gn-text', lang: 'en', hidden: true });
    const full = a.text.replace(/\s+/g, ' ').trim();
    const setText = (all: boolean) => {
      body.replaceChildren(all || full.length <= GENIUS_CLIP ? full : `${full.slice(0, GENIUS_CLIP)}…`);
      if (!all && full.length > GENIUS_CLIP) {
        body.append(h('button', { class: 'll-gn-more', type: 'button', onclick: () => setText(true) }, '続きを読む'));
      }
    };
    setText(false);
    const toggle = h('button', {
      class: 'll-gn-toggle',
      type: 'button',
      'aria-expanded': 'false',
      onclick: () => {
        const show = body.hidden;
        body.hidden = !show;
        toggle.setAttribute('aria-expanded', String(show));
        toggle.textContent = show ? 'たたむ ▴' : GN_LABEL;
        onToggle();
      },
    }, GN_LABEL);
    return h('div', { class: 'll-gn' }, toggle, h('span', { class: 'll-gn-votes' }, `▲${a.votes}`), body);
  }
}
