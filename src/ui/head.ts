/*
 * The head (docs/design-plan-v4.md): one ruled row (icon, the primary action or the status,
 * the count, the links, a hairline progress bar), quiet captions under it, then the preface.
 * It sits at the top of the first lyrics block, after Genius' own lyrics header. The links
 * never move: each owns a slot in every state (see SLOTS).
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
  /** The optional primary first, then the links. A link takes its slot (SLOTS) wherever it
   *  comes in this list; a slot with no action here stays as an invisible placeholder. */
  actions: HeadAction[];
  preface?: { who: string; what: string; collapsed: boolean; onToggle: () => void } | null;
}

let prefaceSeq = 0;

/** 止める appears in the slot of the button just pressed (日本語で読む → 止める): a double tap or
 *  key auto-repeat must not land on it. */
const isStop = (id?: string): boolean => id === 'stop' || id === 'stopMirror';
const STOP_GRACE_MS = 600;
const SETTLE_MS = 600;

/** The links in their places, left to right. A link that is absent in a view still holds its
 *  slot (an invisible, inert placeholder with the usual label), so 止める never jumps left when
 *  訳を隠す and 設定 arrive or leave. Any other link follows the last slot. */
const SLOTS: { slot: string; label: string; takes: (id?: string) => boolean }[] = [
  { slot: 'stop', label: '止める', takes: (id) => id === 'stop' || id === 'stopMirror' || id === 'stopOther' },
  { slot: 'hide', label: '訳を隠す', takes: (id) => id === 'hide' },
  { slot: 'settings', label: '設定', takes: (id) => id === 'settings' },
];

/** A button of the row, in DOM order. `slot` names where it sits ('p0' the primary, a SLOTS
 *  name, 'x0' another link); the same slot is the same place from one view to the next, which
 *  is how focus finds its way back. No `action`: the slot is empty in this view. */
interface Entry {
  slot: string;
  label: string;
  action: HeadAction | null;
}

function entriesOf(actions: HeadAction[]): Entry[] {
  const out: Entry[] = actions.filter((a) => a.primary).map((action, i) => ({ slot: `p${i}`, label: action.label, action }));
  const links = actions.filter((a) => !a.primary);
  // No link at all (the first run, a Japanese song): no row of placeholders either.
  if (!links.length) return out;
  const placed = new Set<HeadAction>();
  for (const s of SLOTS) {
    const action = links.find((a) => !placed.has(a) && s.takes(a.id)) ?? null;
    if (action) placed.add(action);
    out.push({ slot: s.slot, label: action?.label ?? s.label, action });
  }
  links.filter((a) => !placed.has(a)).forEach((action, i) => out.push({ slot: `x${i}`, label: action.label, action }));
  return out;
}

type Focus = { kind: 'action'; slot: string } | { kind: 'preface' };

/** Every control of the row that can take focus (a placeholder cannot). */
const LIVE_BUTTON = '.ll-head-row .ll-btn:not([data-absent])';

export class HeadRow {
  private el: HTMLElement | null = null;
  private sig = '';
  /** Since when a stop action has been on screen (null when none is): the guard follows the
   *  presence of 止める, not each rebuilt button. */
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
    const entries = entriesOf(view.actions);
    const sig = JSON.stringify([view.status, view.tone, Boolean(view.count), progressKind, view.captions.map((c) => [c.text, c.tone]), entries.map((e) => [e.slot, e.action && [e.action.id, e.action.label, e.action.disabled]]), view.preface && [view.preface.who, view.preface.what, view.preface.collapsed]]);
    if (view.state) this.el.dataset.llState = view.state;
    const hadStop = this.stopSince !== null;
    const stopNow = entries.some((e) => e.action && isStop(e.action.id));
    this.stopSince = stopNow ? (hadStop ? this.stopSince : performance.now()) : null;
    if (sig !== this.sig) {
      // Rebuilding destroys the focused control: remember which one it was.
      const focus = this.focusedSlot();
      this.sig = sig;
      this.el.replaceChildren(...this.content(view, entries));
      if (focus) this.restoreFocus(focus, entries, hadStop);
    } else {
      // A tapped button was locked in place; state decides whether it stays locked.
      for (const e of entries) {
        const b = e.action ? this.el.querySelector<HTMLButtonElement>(`.ll-head-row .ll-btn[data-slot="${e.slot}"]`) : null;
        if (b && e.action) b.disabled = Boolean(e.action.disabled);
      }
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
    this.el?.querySelector<HTMLElement>(`${LIVE_BUTTON}:not(:disabled), .ll-preface-more`)?.focus({ preventScroll: true });
  }

  clear(): void {
    this.el?.remove();
    this.el = null;
    this.sig = '';
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

  private focusedSlot(): Focus | null {
    const active = document.activeElement;
    if (!this.el || !active || !this.el.contains(active)) return null;
    if (active.classList.contains('ll-preface-more')) return { kind: 'preface' };
    const slot = active.matches('.ll-head-row .ll-btn') ? (active as HTMLElement).dataset.slot : undefined;
    return slot ? { kind: 'action', slot } : null;
  }

  /** Focus goes back to the same control, found by its slot. If that control is gone the first
   *  one left takes it, except a 止める that has just taken the place of the button pressed: a
   *  second tap or a repeating key must not land on it, so the status line holds focus then. */
  private restoreFocus(focus: Focus, entries: Entry[], hadStop: boolean): void {
    const el = this.el;
    if (!el) return;
    const same = focus.kind === 'preface'
      ? el.querySelector<HTMLElement>('.ll-preface-more')
      : el.querySelector<HTMLElement>(`${LIVE_BUTTON}[data-slot="${focus.slot}"]`);
    if (same) {
      same.focus({ preventScroll: true });
      return;
    }
    const next = entries.find((e) => e.action)?.action;
    if (next && isStop(next.id) && !hadStop && this.statusEl) this.statusEl.focus({ preventScroll: true });
    else el.querySelector<HTMLElement>(LIVE_BUTTON)?.focus({ preventScroll: true });
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

  private content(view: HeadView, entries: Entry[]): Node[] {
    const button = ({ slot, label, action: a }: Entry): HTMLButtonElement => {
      // An empty slot: the usual label keeps its width, but it cannot be seen, read, reached or pressed.
      if (!a) {
        return h('button', {
          class: 'll-btn',
          type: 'button',
          'data-slot': slot,
          'data-absent': '',
          inert: true,
          'aria-hidden': 'true',
          tabindex: '-1',
          style: 'visibility: hidden',
        }, label);
      }
      const b: HTMLButtonElement = h('button', {
        class: 'll-btn',
        type: 'button',
        'data-slot': slot,
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
      }, label);
      return b;
    };
    const primary = entries.filter((e) => e.action?.primary).map(button);
    const links = entries.filter((e) => !e.action?.primary).map(button);
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
