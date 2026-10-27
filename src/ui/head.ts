/*
 * The head row (docs/DESIGN.md §2 rows 1–2): one line of status and the few controls that
 * matter right now, with the preface (誰が誰に / この曲は) underneath. It sits at the top of
 * the first lyrics block, after Genius' own lyrics header.
 */
import { isOwnNode, type PageSong } from '../genius/extract';
import { h, isolateClicks } from './dom';

export interface HeadAction {
  /** What the button does (state machine action id): part of the render signature, so a
   *  button that looks the same but does something else is rebuilt with its new handler. */
  id?: string;
  label: string;
  onClick: (button: HTMLElement) => void;
  disabled?: boolean;
  primary?: boolean;
}

export interface HeadView {
  status: string;
  tone?: 'normal' | 'muted';
  actions: HeadAction[];
  /** Small line under the row (e.g. buffered transport, why a button is disabled). */
  note?: string;
  preface?: { who: string; what: string; collapsed: boolean; onToggle: () => void } | null;
  /** State name (S2, S6…), exposed as data-ll-state for debugging and tests. */
  state?: string;
}

let prefaceSeq = 0;

/** 止める appears in the slot of the button just pressed (日本語で読む → 止める): a double tap or
 *  key auto-repeat must not land on it. */
const isStop = (id?: string): boolean => id === 'stop' || id === 'stopMirror';
const STOP_GRACE_MS = 600;

export class HeadRow {
  private el: HTMLElement | null = null;
  private sig = '';
  /** Action ids of the last render, and since when a stop action has been on screen
   *  (null when none is): the guard follows the presence of 止める, not each rebuilt button. */
  private prevIds: string[] = [];
  private stopSince: number | null = null;
  /** The live region outlives every rebuild of the row: a region inserted already holding its
   *  text is not announced, one whose text changes in place is. */
  private statusEl: HTMLSpanElement | null = null;
  private readonly whatId = `ll-preface-what-${(prefaceSeq += 1)}`;

  get element(): HTMLElement | null {
    return this.el;
  }

  render(page: PageSong, view: HeadView): void {
    const first = page.containers[0];
    if (!first?.isConnected) return;
    if (!this.el) {
      this.el = h('div', { class: 'll-head', lang: 'ja', 'data-exclude-from-selection': 'true' });
      isolateClicks(this.el);
    }
    const sig = JSON.stringify([view.status, view.tone, view.note, view.actions.map((a) => [a.id, a.label, a.disabled, a.primary]), view.preface && [view.preface.who, view.preface.what, view.preface.collapsed]]);
    if (view.state) this.el.dataset.llState = view.state;
    const ids = view.actions.map((a) => a.id ?? '');
    const prevIds = this.prevIds;
    const hadStop = prevIds.some(isStop);
    this.stopSince = ids.some(isStop) ? (hadStop && this.stopSince !== null ? this.stopSince : performance.now()) : null;
    this.prevIds = ids;
    if (sig !== this.sig) {
      // Rebuilding destroys the focused control: remember which one it was.
      const focus = this.focusedSlot();
      this.sig = sig;
      this.el.replaceChildren(...this.content(view));
      if (focus) {
        // Focus must not slide onto a 止める that took the place of the button just pressed.
        const landsOnStop = focus.kind === 'action' && isStop(ids[focus.index]) && !isStop(prevIds[focus.index]);
        if (landsOnStop && this.statusEl) this.statusEl.focus({ preventScroll: true });
        else this.restoreFocus(focus);
      }
    } else {
      // A tapped button was locked in place; state decides whether it stays locked.
      this.el.querySelectorAll<HTMLButtonElement>('.ll-actions .ll-btn').forEach((b, i) => { b.disabled = Boolean(view.actions[i]?.disabled); });
    }
    // Inside the first block, after Genius' header (contributors, translations…) — never
    // after one of our own nodes, which also carry data-exclude-from-selection.
    const header = Array.from(first.children).find((c) => c !== this.el && !isOwnNode(c) && c.hasAttribute('data-exclude-from-selection')) ?? null;
    const placed = this.el.parentNode === first && (header ? this.el.previousElementSibling === header : first.firstChild === this.el);
    if (!placed) first.insertBefore(this.el, header ? header.nextSibling : first.firstChild);
  }

  /** Puts keyboard focus on the first control (used when a line control vanished). */
  focusFirst(): void {
    this.el?.querySelector<HTMLElement>('.ll-actions .ll-btn:not(:disabled), .ll-preface-toggle')?.focus({ preventScroll: true });
  }

  clear(): void {
    this.el?.remove();
    this.el = null;
    this.sig = '';
    this.prevIds = [];
    this.stopSince = null;
    this.statusEl = null;
  }

  private focusedSlot(): { kind: 'action'; index: number } | { kind: 'preface' } | null {
    const active = document.activeElement;
    if (!this.el || !active || !this.el.contains(active)) return null;
    if (active.classList.contains('ll-preface-toggle')) return { kind: 'preface' };
    const buttons = Array.from(this.el.querySelectorAll('.ll-actions .ll-btn'));
    const index = buttons.indexOf(active);
    return index >= 0 ? { kind: 'action', index } : null;
  }

  private restoreFocus(slot: { kind: 'action'; index: number } | { kind: 'preface' }): void {
    const el = this.el;
    if (!el) return;
    const target = slot.kind === 'preface'
      ? el.querySelector<HTMLElement>('.ll-preface-toggle')
      : el.querySelectorAll<HTMLElement>('.ll-actions .ll-btn')[slot.index] ?? null;
    (target ?? el.querySelector<HTMLElement>('.ll-actions .ll-btn'))?.focus({ preventScroll: true });
  }

  /** The one status node, created once and re-appended into each rebuilt row. Never `hidden`
   *  (display: none drops it from the accessibility tree); an empty one is collapsed by CSS. */
  private statusNode(view: HeadView): HTMLSpanElement {
    const el = this.statusEl ?? (this.statusEl = h('span', { class: 'll-status', role: 'status', 'aria-live': 'polite', tabindex: '-1' }));
    el.dataset.tone = view.tone ?? 'normal';
    if (el.textContent !== view.status) el.textContent = view.status;
    if (view.status) delete el.dataset.empty;
    else el.dataset.empty = '1';
    return el;
  }

  private content(view: HeadView): Node[] {
    const row = h('div', { class: 'll-head-row', dataset: { bare: view.status ? '' : '1' } },
      this.statusNode(view),
      h('span', { class: 'll-actions' }, view.actions.map((a) => {
        const button: HTMLButtonElement = h('button', {
          class: 'll-btn',
          type: 'button',
          disabled: Boolean(a.disabled),
          'data-primary': a.primary ? '' : null,
          onclick: (e: Event) => {
            e.preventDefault();
            if (button.disabled) return;
            if (isStop(a.id) && this.stopSince !== null && performance.now() - this.stopSince < STOP_GRACE_MS) return;
            // Lock at once; the next render rebuilds the button from state.
            if (a.primary) button.disabled = true;
            a.onClick(button);
          },
        }, a.label);
        return button;
      })),
    );
    const out: Node[] = [row];
    if (view.note) out.push(h('span', { class: 'll-head-note' }, view.note));
    const p = view.preface;
    if (p && (p.who || p.what)) {
      // The preface is text (readable, selectable, announced); only the chevron toggles it.
      out.push(h('div', { class: 'll-preface', dataset: { collapsed: p.collapsed ? '1' : '' } },
        h('div', { class: 'll-preface-rows' },
          h('div', { class: 'll-preface-row ll-preface-who' }, h('span', { class: 'll-preface-label' }, '誰が誰に'), h('span', null, p.who)),
          h('div', { class: 'll-preface-row ll-preface-what', id: this.whatId, hidden: p.collapsed }, h('span', { class: 'll-preface-label' }, 'この曲は'), h('span', null, p.what)),
        ),
        h('button', {
          class: 'll-preface-toggle',
          type: 'button',
          'aria-expanded': String(!p.collapsed),
          'aria-controls': this.whatId,
          'aria-label': p.collapsed ? 'この曲についてを開く' : 'この曲についてを閉じる',
          onclick: (e: Event) => { e.preventDefault(); p.onToggle(); },
        }, p.collapsed ? '▸' : '▾'),
      ));
    }
    return out;
  }
}
