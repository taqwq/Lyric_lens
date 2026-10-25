/*
 * The head row (docs/DESIGN.md §2 rows 1–2): one line of status and the few controls that
 * matter right now, with the preface (誰が誰に / この曲は) underneath. It sits at the top of
 * the first lyrics block, after Genius' own lyrics header.
 */
import type { PageSong } from '../genius/extract';
import { h, isolateClicks } from './dom';

export interface HeadAction {
  label: string;
  onClick: (button: HTMLElement) => void;
  disabled?: boolean;
  primary?: boolean;
}

export interface HeadView {
  status: string;
  tone?: 'normal' | 'muted';
  actions: HeadAction[];
  /** Small line under the row (e.g. buffered transport). */
  note?: string;
  preface?: { who: string; what: string; collapsed: boolean; onToggle: () => void } | null;
}

export class HeadRow {
  private el: HTMLElement | null = null;
  private sig = '';

  render(page: PageSong, view: HeadView): void {
    const first = page.containers[0];
    if (!first?.isConnected) return;
    if (!this.el) {
      this.el = h('div', { class: 'll-head', lang: 'ja', 'data-exclude-from-selection': 'true' });
      isolateClicks(this.el);
    }
    const sig = JSON.stringify([view.status, view.tone, view.note, view.actions.map((a) => [a.label, a.disabled, a.primary]), view.preface && [view.preface.who, view.preface.what, view.preface.collapsed]]);
    if (sig !== this.sig) {
      this.sig = sig;
      this.el.replaceChildren(...this.content(view));
    }
    // Inside the first block, after Genius' header (contributors, translations…).
    const header = Array.from(first.children).find((c) => c.hasAttribute('data-exclude-from-selection') && c !== this.el) ?? null;
    const placed = this.el.parentNode === first && (header ? this.el.previousElementSibling === header : first.firstChild === this.el);
    if (!placed) first.insertBefore(this.el, header ? header.nextSibling : first.firstChild);
  }

  clear(): void {
    this.el?.remove();
    this.el = null;
    this.sig = '';
  }

  private content(view: HeadView): Node[] {
    const row = h('div', { class: 'll-head-row', dataset: { bare: view.status ? '' : '1' } },
      h('span', { class: 'll-status', dataset: { tone: view.tone ?? 'normal' }, role: 'status', 'aria-live': 'polite', hidden: !view.status }, view.status),
      h('span', { class: 'll-actions' }, view.actions.map((a) => {
        const button: HTMLButtonElement = h('button', {
          class: 'll-btn',
          type: 'button',
          disabled: Boolean(a.disabled),
          'data-primary': a.primary ? '' : null,
          onclick: (e: Event) => { e.preventDefault(); a.onClick(button); },
        }, a.label);
        return button;
      })),
    );
    const out: Node[] = [row];
    if (view.note) out.push(h('span', { class: 'll-head-note' }, view.note));
    const p = view.preface;
    if (p && (p.who || p.what)) {
      out.push(h('div', { class: 'll-preface', dataset: { collapsed: p.collapsed ? '1' : '' } },
        h('button', {
          class: 'll-preface-toggle',
          type: 'button',
          'aria-expanded': String(!p.collapsed),
          'aria-label': p.collapsed ? 'この曲についてを開く' : 'この曲についてを閉じる',
          onclick: (e: Event) => { e.preventDefault(); p.onToggle(); },
        },
          h('span', { class: 'll-preface-rows' },
            h('span', { class: 'll-preface-row ll-preface-who' }, h('span', { class: 'll-preface-label' }, '誰が誰に'), h('span', null, p.who)),
            h('span', { class: 'll-preface-row ll-preface-what' }, h('span', { class: 'll-preface-label' }, 'この曲は'), h('span', null, p.what)),
          ),
          h('span', { class: 'll-preface-chev', 'aria-hidden': 'true' }, p.collapsed ? '▸' : '▾'),
        ),
      ));
    }
    return out;
  }
}
