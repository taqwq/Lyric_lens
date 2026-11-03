/*
 * The ruled paper: one node under every lyric line (docs/DESIGN.md §2 row 3). A node is an
 * empty slot, the next slot (breathing), a filled translation, a gap (――) or, under a line
 * that is only sounds, a ♪. Where an interrupted translation stopped, one more node, the seam,
 * sits between the last translated line and the plain English that follows. Rendering is
 * idempotent: nodes are reused in place.
 */
import { splitAdlibs, visibleJa } from '../core/adlib';
import { NOTE_LABELS, type SongRecord } from '../core/types';
import type { PageSong } from '../genius/extract';
import { h, isolateClicks } from './dom';

export interface SeamView {
  text: string;
  button: { label: string; disabled?: boolean; onClick: () => void };
}

export interface LinesInput {
  page: PageSong;
  record: SongRecord | null;
  /** Missing lines show empty ruled slots (waiting, arriving, interrupted). */
  slots: boolean;
  /** Missing lines show a quiet "――" instead (lines the model skipped). */
  gaps: boolean;
  /** The first empty slot breathes while a request is in flight. */
  breathing: boolean;
  /** The stop point: drawn after the last translated line; from the first missing line on,
   *  nothing is drawn (the English stays plain until the reader resumes). */
  seam: SeamView | null;
  /** Fade newly filled lines in (never on a cached render). */
  animate: boolean;
  /** The first render right after the reader's tap that creates the empty slots: slots near
   *  the viewport unfold (data-enter). Never set on a cached render. */
  opening?: boolean;
  openIndex: number | null;
  onMark: (index: number) => void;
  onMarkHover?: (index: number, on: boolean) => void;
}

type State = 'empty' | 'next' | 'filled' | 'gap' | 'voice';

/** Kana or kanji (as in song.ts): a line that is Japanese already needs no row. */
const JAPANESE = /[぀-ヿ一-鿿]/;

/** Within the viewport ±600 px: only those slots are worth animating. */
function nearViewport(anchor: Node): boolean {
  const target = anchor instanceof Element ? anchor : anchor.parentElement;
  if (!target) return true;
  const rect = target.getBoundingClientRect();
  return rect.bottom > -600 && rect.top < window.innerHeight + 600;
}

function insertAfter(anchor: Node, el: Node): boolean {
  if (!anchor.parentNode || !anchor.isConnected) return false;
  anchor.parentNode.insertBefore(el, anchor.nextSibling);
  return true;
}

export class LineRenderer {
  private readonly nodes = new Map<number, HTMLElement>();
  private readonly sigs = new Map<number, string>();
  /** The seam's own node (it belongs to no line), what it shows, and the line whose anchor it follows. */
  private seam: HTMLElement | null = null;
  private seamSig = '';
  private seamAfter = -1;
  private page: PageSong | null = null;

  nodeFor(index: number): HTMLElement | undefined {
    return this.nodes.get(index);
  }

  /** The stop point's node while one is shown (it belongs to no line). */
  seamNode(): HTMLElement | null {
    return this.seam;
  }

  render(input: LinesInput): void {
    const { page, record } = input;
    if (this.page && this.page.path !== page.path) this.clear();
    this.page = page;
    for (const [i, el] of this.nodes) {
      if (i < page.source.lines.length) continue;
      el.remove();
      this.nodes.delete(i);
      this.sigs.delete(i);
    }

    // The frontier is where writing stopped (or continues): the first missing line after the
    // last filled one. Holes before it are lines the model skipped, not the place to resume.
    // Only first occurrences count: a chorus repeat is filled together with its first
    // occurrence, ahead of the unique lines still to be written above it.
    // A line of sounds is never written, so it is neither filled nor still to come.
    const filled = (i: number) => Boolean(record?.lines[page.source.lines[i]!.key]?.ja);
    const toWrite = (i: number) => !page.source.lines[i]!.sound && !filled(i);
    let lastFilled = -1;
    page.source.lines.forEach((line, i) => { if (line.occurrence === 0 && !line.sound && filled(i)) lastFilled = i; });
    let frontier = page.source.lines.findIndex((_, i) => i > lastFilled && toWrite(i));
    if (frontier < 0) frontier = page.source.lines.findIndex((_, i) => toWrite(i));
    // With a seam to show, writing stopped at the frontier: from there on the page is plain
    // English, even where a repeat is already translated, until the reader resumes.
    const stopAt = input.seam && frontier >= 0 ? frontier : -1;
    // Rows are drawn at all: a translation is being written, was cut short, or is on the page.
    const ruled = input.slots || input.gaps || Boolean(input.seam) || lastFilled >= 0;
    page.source.lines.forEach((line, i) => {
      const anchor = page.anchors[i];
      const result = record?.lines[line.key];
      // What is left to show once the sounds and an echo of the English are taken out (adlib.ts).
      const ja = result?.ja ? visibleJa(result.ja, line.text) : '';
      let state: State | null = null;
      if (stopAt >= 0 && i >= stopAt) state = null;
      // A line of sounds is never written: wherever rows are drawn, its row is a quiet ♪, so it
      // reads as done rather than missing, even where an older edition stored one (ウー、オー).
      else if (line.sound) state = ruled ? 'voice' : null;
      // So is a row with nothing left once its sounds go, or one that repeats its English line
      // (the prompt leaves nothing but sounds as written), unless the line was Japanese already.
      else if (result?.ja) state = ja ? 'filled' : JAPANESE.test(line.text) ? null : 'voice';
      else if (input.gaps) state = 'gap';
      else if (input.slots) state = i < frontier && lastFilled > i ? 'gap' : input.breathing && i === frontier ? 'next' : 'empty';

      const current = this.nodes.get(i);
      if (!state || !anchor) {
        current?.remove();
        this.nodes.delete(i);
        this.sigs.delete(i);
        return;
      }
      const notes = result?.notes ?? [];
      const repeat = line.occurrence > 0;
      const open = input.openIndex === i;
      // `open` is deliberately not part of the signature: rebuilding would destroy the
      // focused ※ button. aria-expanded is synced in place below.
      const sig = [state, line.key, result?.ja ?? '', repeat, notes.length, notes[0]?.phrase ?? '',
        notes.map((n) => n.kind).join(',')].join('\u0001');

      let el = current;
      if (!el) {
        el = h('span', { class: 'll-line', lang: 'ja', 'data-exclude-from-selection': 'true' });
        isolateClicks(el);
      }
      if (this.sigs.get(i) !== sig) {
        const isNew = !current;
        const wasWaiting = el.dataset.state === 'empty' || el.dataset.state === 'next';
        el.dataset.state = state;
        if (repeat) el.dataset.repeat = ''; else delete el.dataset.repeat;
        // A placeholder bar about as long as the translation will be (styles.css: --ll-n).
        el.style.setProperty('--ll-n', String(Math.min(120, line.text.length)));
        el.replaceChildren(...this.content(state, i, ja, notes.length, input));
        if (state === 'filled' && wasWaiting && input.animate) {
          el.dataset.ink = '';
          setTimeout(() => { if (el) delete el.dataset.ink; }, 260);
        }
        if (input.opening && isNew && (state === 'empty' || state === 'next' || state === 'voice') && nearViewport(anchor)) {
          const node = el;
          node.dataset.enter = '';
          const done = () => { delete node.dataset.enter; };
          node.addEventListener('animationend', done, { once: true });
          setTimeout(done, 400);
        }
        this.sigs.set(i, sig);
      }
      el.querySelector('.ll-mark')?.setAttribute('aria-expanded', String(open));
      if (!el.isConnected || el.previousSibling !== anchor) {
        // On a stale page the anchor may be detached: keep the node, the next refresh
        // (triggered by damaged()) moves it to the new anchor.
        if (!insertAfter(anchor, el)) return;
      }
      this.nodes.set(i, el);
    });

    this.renderSeam(input.seam, page, stopAt);

    // Remove our nodes that no line owns any more (Genius re-render, lyric edits).
    const live = new Set(this.nodes.values());
    if (this.seam) live.add(this.seam);
    for (const container of page.containers) {
      container.querySelectorAll<HTMLElement>('.ll-line').forEach((n) => { if (!live.has(n)) n.remove(); });
    }
  }

  /** The seam is its own node, reused while it stays: right after the last translated line
   *  (past the note open under it) so the page reads [English][Japanese][seam][English, plain].
   *  If that line has no node it follows the line's anchor; with nothing translated before the
   *  stop (stopAt 0) it follows the first line's anchor. */
  private renderSeam(seam: SeamView | null, page: PageSong, stopAt: number): void {
    if (!seam || stopAt < 0) {
      this.seam?.remove();
      this.seam = null;
      this.seamSig = '';
      this.seamAfter = -1;
      return;
    }
    let el = this.seam;
    if (!el) {
      el = h('span', { class: 'll-line', lang: 'ja', 'data-state': 'seam', 'data-exclude-from-selection': 'true' });
      isolateClicks(el);
      this.seam = el;
    }
    const sig = `${seam.text}|${seam.button.label}|${seam.button.disabled}`;
    if (this.seamSig !== sig) {
      el.replaceChildren(this.seamContent(seam));
      this.seamSig = sig;
    }
    const button = el.querySelector<HTMLButtonElement>('.ll-seam .ll-btn');
    if (button) button.disabled = Boolean(seam.button.disabled);

    const last = Math.max(stopAt - 1, 0);
    this.seamAfter = last;
    const lineNode = this.nodes.get(last);
    let after: Node | undefined = lineNode ?? page.anchors[last];
    while (lineNode && after?.nextSibling instanceof Element && after.nextSibling.classList.contains('ll-note')) after = after.nextSibling;
    // A detached anchor (stale page): keep the node, damaged() has the next refresh move it.
    if (after && (!el.isConnected || el.previousSibling !== after)) insertAfter(after, el);
  }

  private seamContent(seam: SeamView): HTMLElement {
    const button: HTMLButtonElement = h('button', {
      class: 'll-btn',
      type: 'button',
      disabled: Boolean(seam.button.disabled),
      onclick: (e: Event) => {
        e.preventDefault();
        if (button.disabled) return;
        button.disabled = true; // a tap sends at most one request
        seam.button.onClick();
      },
    }, seam.button.label);
    return h('span', { class: 'll-seam' }, h('span', { class: 'll-seam-text' }, seam.text), button);
  }

  private content(state: State, index: number, ja: string, noteCount: number, input: LinesInput): Node[] {
    if (state === 'empty') return [h('span', { class: 'll-ja', 'aria-hidden': 'true' })];
    if (state === 'next') return [h('span', { class: 'll-ja', 'aria-hidden': 'true' }, h('span', { class: 'll-pen' }))];
    if (state === 'gap') return [h('span', { class: 'll-ja', role: 'img', 'aria-label': 'この行は訳せていません' }, '――')];
    if (state === 'voice') return [h('span', { class: 'll-ja', role: 'img', 'aria-label': '声だけの行' }, '♪')];
    // Trailing ad-lib groups in a quieter ink, so the eye lands on the line itself.
    const { main, tail } = splitAdlibs(ja, input.page.source.lines[index]?.text ?? '');
    const out: Node[] = [h('span', { class: 'll-ja' }, main, tail ? h('span', { class: 'll-adlib' }, tail) : null)];
    if (noteCount) {
      const record = input.record;
      const line = input.page.source.lines[index];
      const notes = (line && record?.lines[line.key]?.notes) || [];
      const first = notes[0];
      const kinds = [...new Set(notes.map((n) => NOTE_LABELS[n.kind]))].join('、');
      // A toggle names what it opens; aria-expanded says whether it is open.
      const label = first ? `注：${kinds}` : '注';
      const mark: HTMLButtonElement = h('button', {
        class: 'll-mark',
        type: 'button',
        'aria-label': label,
        'aria-expanded': 'false',
        onclick: (e: Event) => { e.preventDefault(); input.onMark(index); },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Escape' && mark.getAttribute('aria-expanded') === 'true') {
            e.preventDefault();
            e.stopPropagation();
            input.onMark(index);
          }
        },
      }, '※');
      if (input.onMarkHover && matchMedia('(pointer: fine)').matches) {
        mark.addEventListener('mouseenter', () => input.onMarkHover?.(index, true));
        mark.addEventListener('mouseleave', () => input.onMarkHover?.(index, false));
      }
      out.push(mark);
    }
    return out;
  }

  /** True when Genius re-rendered and dropped our nodes or the anchors they follow. */
  damaged(): boolean {
    if (!this.page) return false;
    for (const [i, el] of this.nodes) {
      if (!el.isConnected || !this.page.anchors[i]?.isConnected) return true;
    }
    return Boolean(this.seam && (!this.seam.isConnected || !this.page.anchors[this.seamAfter]?.isConnected));
  }

  clear(): void {
    this.nodes.forEach((el) => el.remove());
    this.nodes.clear();
    this.sigs.clear();
    this.seam = null;
    this.seamSig = '';
    this.seamAfter = -1;
    document.querySelectorAll('.ll-line').forEach((el) => el.remove());
    this.page = null;
  }
}
