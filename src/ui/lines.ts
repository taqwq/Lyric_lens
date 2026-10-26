/*
 * The ruled paper: one node under every lyric line (docs/DESIGN.md §2 row 3). A node is an
 * empty slot, the next slot (breathing), a filled translation, a gap, or the seam where an
 * interrupted translation stopped. Rendering is idempotent: nodes are reused in place.
 */
import { splitAdlibs } from '../core/adlib';
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
  /** Missing lines show a quiet "—" instead (lines the model skipped). */
  gaps: boolean;
  /** The first empty slot breathes while a request is in flight. */
  breathing: boolean;
  /** Replaces the first missing line's slot. */
  seam: SeamView | null;
  /** Fade newly filled lines in (never on a cached render). */
  animate: boolean;
  openIndex: number | null;
  onMark: (index: number) => void;
  onMarkHover?: (index: number, on: boolean) => void;
}

type State = 'empty' | 'next' | 'filled' | 'gap' | 'seam';

function insertAfter(anchor: Node, el: Node): boolean {
  if (!anchor.parentNode || !anchor.isConnected) return false;
  anchor.parentNode.insertBefore(el, anchor.nextSibling);
  return true;
}

export class LineRenderer {
  private readonly nodes = new Map<number, HTMLElement>();
  private readonly sigs = new Map<number, string>();
  private page: PageSong | null = null;

  nodeFor(index: number): HTMLElement | undefined {
    return this.nodes.get(index);
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
    const filled = (i: number) => Boolean(record?.lines[page.source.lines[i]!.key]?.ja);
    let lastFilled = -1;
    page.source.lines.forEach((line, i) => { if (line.occurrence === 0 && filled(i)) lastFilled = i; });
    let frontier = page.source.lines.findIndex((_, i) => i > lastFilled && !filled(i));
    if (frontier < 0) frontier = page.source.lines.findIndex((_, i) => !filled(i));
    page.source.lines.forEach((line, i) => {
      const anchor = page.anchors[i];
      const result = record?.lines[line.key];
      let state: State | null = null;
      if (result?.ja) state = 'filled';
      else if (input.seam && i === frontier) state = 'seam';
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
        state === 'seam' ? `${input.seam?.text}|${input.seam?.button.label}|${input.seam?.button.disabled}` : ''].join('\u0001');

      let el = current;
      if (!el) {
        el = h('span', { class: 'll-line', lang: 'ja', 'data-exclude-from-selection': 'true' });
        isolateClicks(el);
      }
      if (this.sigs.get(i) !== sig) {
        const wasWaiting = el.dataset.state === 'empty' || el.dataset.state === 'next';
        el.dataset.state = state;
        if (repeat) el.dataset.repeat = ''; else delete el.dataset.repeat;
        el.replaceChildren(...this.content(state, i, result?.ja ?? '', notes.length, repeat, input));
        if (state === 'filled' && wasWaiting && input.animate) {
          el.dataset.ink = '';
          setTimeout(() => { if (el) delete el.dataset.ink; }, 260);
        }
        this.sigs.set(i, sig);
      }
      el.querySelector('.ll-mark')?.setAttribute('aria-expanded', String(open));
      const seamButton = state === 'seam' ? el.querySelector<HTMLButtonElement>('.ll-seam .ll-btn') : null;
      if (seamButton) seamButton.disabled = Boolean(input.seam?.button.disabled);
      if (!el.isConnected || el.previousSibling !== anchor) {
        // On a stale page the anchor may be detached: keep the node, the next refresh
        // (triggered by damaged()) moves it to the new anchor.
        if (!insertAfter(anchor, el)) return;
      }
      this.nodes.set(i, el);
    });

    // Remove our nodes that no line owns any more (Genius re-render, lyric edits).
    const live = new Set(this.nodes.values());
    for (const container of page.containers) {
      container.querySelectorAll<HTMLElement>('.ll-line').forEach((n) => { if (!live.has(n)) n.remove(); });
    }
  }

  private content(state: State, index: number, ja: string, noteCount: number, repeat: boolean, input: LinesInput): Node[] {
    if (state === 'empty' || state === 'next') return [h('span', { class: 'll-ja', 'aria-hidden': 'true' })];
    if (state === 'gap') return [h('span', { class: 'll-ja', role: 'img', 'aria-label': 'まだ訳せていない行' }, '—')];
    if (state === 'seam' && input.seam) {
      const { seam } = input;
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
      return [h('span', { class: 'll-seam' }, h('span', { class: 'll-seam-text' }, seam.text), button)];
    }
    // Trailing ad-lib groups in a quieter ink, so the eye lands on the line itself.
    const { main, tail } = splitAdlibs(ja, input.page.source.lines[index]?.text ?? '');
    const out: Node[] = [h('span', { class: 'll-ja' }, main, tail ? h('span', { class: 'll-adlib' }, tail) : null)];
    if (repeat) out.push(h('span', { class: 'll-repeat', role: 'img', 'aria-label': 'くり返し' }, '↺'));
    if (noteCount) {
      const record = input.record;
      const line = input.page.source.lines[index];
      const notes = (line && record?.lines[line.key]?.notes) || [];
      const first = notes[0];
      const label = notes.length > 1 ? `注 ${notes.length}件` : first ? `注：${NOTE_LABELS[first.kind]}「${first.phrase}」` : '注';
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
    return false;
  }

  clear(): void {
    this.nodes.forEach((el) => el.remove());
    this.nodes.clear();
    this.sigs.clear();
    document.querySelectorAll('.ll-line').forEach((el) => el.remove());
    this.page = null;
  }
}
