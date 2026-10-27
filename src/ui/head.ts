/*
 * The head (docs/design-plan-v4.md): one ruled row (icon, the primary action or the status,
 * the count, the links, a hairline progress bar), quiet captions under it, then the preface.
 * It sits at the top of the first lyrics block, after Genius' own lyrics header.
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
  /** State name (S2, S6…), exposed as data-ll-state for debugging and tests. */
  state?: string;
  tone: 'speaking' | 'settled';
  /** The left-hand sentence when there is no primary button ('' otherwise). */
  status: string;
  /** e.g. '（12/67行）'. */
  count?: string;
  progress?: { value: number; max: number } | 'indeterminate' | null;
  /** A run in this session just completed: the row settles once (600 ms). */
  settle?: boolean;
  captions: { text: string; tone?: 'reason' }[];
  /** The optional primary first, then the links in their fixed order. */
  actions: HeadAction[];
  preface?: { who: string; what: string; collapsed: boolean; onToggle: () => void } | null;
}

let prefaceSeq = 0;

/** 止める appears in the slot of the button just pressed (日本語で読む → 止める): a double tap or
 *  key auto-repeat must not land on it. */
const isStop = (id?: string): boolean => id === 'stop' || id === 'stopMirror';
const STOP_GRACE_MS = 600;
const SETTLE_MS = 600;

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
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly whatId = `ll-preface-what-${(prefaceSeq += 1)}`;

  get element(): HTMLElement | null {
    return this.el;
  }

  render(page: PageSong, view: HeadView): void {
    const first = page.containers[0];
    if (!first?.isConnected) return;
    if (!this.el) {
      this.el = h('div', { class: 'll-head', lang: 'ja', role: 'region', 'aria-label': 'Lyric Lens 日本語訳', 'data-exclude-from-selection': 'true' });
      isolateClicks(this.el);
    }
    // The count and the bar's value change with every line: they are written in place below,
    // so the bar's width transition runs and nothing is rebuilt (or loses focus) per line.
    const p = view.progress;
    const progressKind = p === 'indeterminate' ? 'i' : p ? `v${p.max}` : '';
    const sig = JSON.stringify([view.status, view.tone, Boolean(view.count), progressKind, view.captions.map((c) => [c.text, c.tone]), view.actions.map((a) => [a.id, a.label, a.disabled, a.primary]), view.preface && [view.preface.who, view.preface.what, view.preface.collapsed]]);
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
      this.el.querySelectorAll<HTMLButtonElement>('.ll-head-row .ll-btn').forEach((b, i) => { b.disabled = Boolean(view.actions[i]?.disabled); });
    }
    this.updateMeter(view);
    if (view.settle && this.settleTimer === null) this.startSettle();
    // Inside the first block, after Genius' header (contributors, translations…) — never
    // after one of our own nodes, which also carry data-exclude-from-selection.
    const header = Array.from(first.children).find((c) => c !== this.el && !isOwnNode(c) && c.hasAttribute('data-exclude-from-selection')) ?? null;
    const placed = this.el.parentNode === first && (header ? this.el.previousElementSibling === header : first.firstChild === this.el);
    if (!placed) first.insertBefore(this.el, header ? header.nextSibling : first.firstChild);
  }

  /** Puts keyboard focus on the first control (used when a line control vanished). */
  focusFirst(): void {
    this.el?.querySelector<HTMLElement>('.ll-head-row .ll-btn:not(:disabled), .ll-preface-more')?.focus({ preventScroll: true });
  }

  clear(): void {
    this.el?.remove();
    this.el = null;
    this.sig = '';
    this.prevIds = [];
    this.stopSince = null;
    this.statusEl = null;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  /** The row settles for 600 ms (a rebuild inside that window keeps the attribute). */
  private startSettle(): void {
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.el?.querySelector('.ll-head-row')?.removeAttribute('data-settle');
    }, SETTLE_MS);
    this.el?.querySelector('.ll-head-row')?.setAttribute('data-settle', '');
  }

  /** Count text and the bar's value, written in place (see render). */
  private updateMeter(view: HeadView): void {
    const row = this.el?.querySelector<HTMLElement>('.ll-head-row');
    if (!row) return;
    const count = row.querySelector<HTMLElement>('.ll-count');
    if (count && view.count && count.textContent !== view.count) count.textContent = view.count;
    const bar = row.querySelector<HTMLElement>('.ll-progress');
    const p = view.progress;
    if (bar && p && p !== 'indeterminate') {
      bar.setAttribute('aria-valuenow', String(p.value));
      bar.style.setProperty('--p', String(p.max > 0 ? Math.round((p.value / p.max) * 1000) / 1000 : 0));
    }
  }

  private focusedSlot(): { kind: 'action'; index: number } | { kind: 'preface' } | null {
    const active = document.activeElement;
    if (!this.el || !active || !this.el.contains(active)) return null;
    if (active.classList.contains('ll-preface-more')) return { kind: 'preface' };
    const buttons = Array.from(this.el.querySelectorAll('.ll-head-row .ll-btn'));
    const index = buttons.indexOf(active);
    return index >= 0 ? { kind: 'action', index } : null;
  }

  private restoreFocus(slot: { kind: 'action'; index: number } | { kind: 'preface' }): void {
    const el = this.el;
    if (!el) return;
    const target = slot.kind === 'preface'
      ? el.querySelector<HTMLElement>('.ll-preface-more')
      : el.querySelectorAll<HTMLElement>('.ll-head-row .ll-btn')[slot.index] ?? null;
    (target ?? el.querySelector<HTMLElement>('.ll-head-row .ll-btn'))?.focus({ preventScroll: true });
  }

  /** The one status node, created once and re-appended into each rebuilt row. Never `hidden`
   *  (display: none drops it from the accessibility tree); an empty one is collapsed by CSS. */
  private statusNode(view: HeadView): HTMLSpanElement {
    const el = this.statusEl ?? (this.statusEl = h('span', { class: 'll-status', role: 'status', 'aria-live': 'polite', tabindex: '-1' }));
    if (el.textContent !== view.status) el.textContent = view.status;
    if (view.status) delete el.dataset.empty;
    else el.dataset.empty = '1';
    return el;
  }

  private content(view: HeadView): Node[] {
    const button = (a: HeadAction): HTMLButtonElement => {
      const b: HTMLButtonElement = h('button', {
        class: 'll-btn',
        type: 'button',
        disabled: Boolean(a.disabled),
        'data-primary': a.primary ? '' : null,
        onclick: (e: Event) => {
          e.preventDefault();
          if (b.disabled) return;
          if (isStop(a.id) && this.stopSince !== null && performance.now() - this.stopSince < STOP_GRACE_MS) return;
          // Lock at once; the next render rebuilds the button from state.
          if (a.primary) b.disabled = true;
          a.onClick(b);
        },
      }, a.label);
      return b;
    };
    const primary = view.actions.filter((a) => a.primary).map(button);
    const links = view.actions.filter((a) => !a.primary).map(button);
    const p = view.progress;
    const row = h('div', { class: 'll-head-row', dataset: { tone: view.tone } },
      h('span', { class: 'll-icon', 'aria-hidden': 'true' }),
      primary,
      this.statusNode(view),
      view.count ? h('span', { class: 'll-count', 'aria-hidden': 'true' }, view.count) : null,
      links.length ? h('span', { class: 'll-links' }, links) : null,
      p === 'indeterminate'
        ? h('span', { class: 'll-progress', role: 'progressbar', 'aria-label': '翻訳の進み具合', 'data-indeterminate': '' })
        : p ? h('span', { class: 'll-progress', role: 'progressbar', 'aria-label': '翻訳の進み具合', 'aria-valuemin': '0', 'aria-valuemax': String(p.max), 'aria-valuenow': String(p.value) }) : null,
    );
    if (this.settleTimer !== null) row.setAttribute('data-settle', '');
    const out: Node[] = [row];
    for (const c of view.captions) out.push(h('span', { class: 'll-caption', ...(c.tone ? { 'data-tone': c.tone } : {}) }, c.text));
    const pf = view.preface;
    if (pf && (pf.who || pf.what)) {
      // The preface is plain text (readable, selectable, announced); on a return visit only
      // the 続きを読む toggle at the end of the first line opens the rest.
      out.push(h('div', { class: 'll-preface' },
        h('p', { class: 'll-preface-who' }, pf.who, pf.collapsed && pf.what
          ? h('button', {
            class: 'll-preface-more',
            type: 'button',
            'aria-expanded': 'false',
            'aria-controls': this.whatId,
            onclick: (e: Event) => { e.preventDefault(); pf.onToggle(); },
          }, '続きを読む ▾')
          : null),
        pf.what ? h('p', { class: 'll-preface-what', id: this.whatId, hidden: pf.collapsed }, pf.what) : null,
      ));
    }
    return out;
  }
}
