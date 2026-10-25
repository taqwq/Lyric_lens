/* Floating controls: one main button whose meaning follows the song's state, a menu,
 * and a panel for progress details and errors. Pure view: the app passes a DockView. */
import { h } from './dom';

export type Tone = 'accent' | 'quiet' | 'busy' | 'error';

export interface DockAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  run: () => void;
}

export interface DockView {
  visible: boolean;
  main: { label: string; tone: Tone; progress?: number | null; title?: string; onClick: () => void };
  panel: null | { tone: 'info' | 'error'; title: string; detail: string; actions: DockAction[] };
  menu: Array<MenuItem | 'sep'>;
}

export class Dock {
  readonly root: HTMLElement;
  private readonly main: HTMLButtonElement;
  private readonly mainLabel: HTMLElement;
  private readonly mainFill: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly moreButton: HTMLButtonElement;
  private view: DockView | null = null;

  constructor() {
    this.mainFill = h('span', { class: 'll-main-fill', 'aria-hidden': 'true' });
    this.mainLabel = h('span', { class: 'll-main-label' });
    this.main = h('button', { class: 'll-main', type: 'button', onclick: () => this.view?.main.onClick() },
      this.mainFill, h('span', { class: 'll-main-dot', 'aria-hidden': 'true' }), this.mainLabel);
    this.moreButton = h('button', {
      class: 'll-icon-btn',
      type: 'button',
      title: 'メニュー',
      'aria-label': 'メニュー',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onclick: () => this.toggleMenu(),
    }, '⋯');
    this.panel = h('div', { class: 'll-panel', role: 'status', 'aria-live': 'polite', hidden: true });
    this.menu = h('div', { class: 'll-menu', role: 'menu', hidden: true });
    this.root = h('div', { class: 'll-root ll-dock', hidden: true },
      this.panel,
      this.menu,
      h('div', { class: 'll-bar' }, this.main, this.moreButton),
    );
    // Keep Genius' handlers out; close the menu on outside clicks / Escape.
    for (const type of ['click', 'mousedown', 'pointerdown', 'keydown']) {
      this.root.addEventListener(type, (e) => e.stopPropagation());
    }
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.hidden && !this.root.contains(e.target as Node)) this.toggleMenu(false);
    }, true);
    this.root.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') this.toggleMenu(false);
    });
  }

  mount(): void {
    if (!this.root.isConnected) document.body.appendChild(this.root);
  }

  update(view: DockView): void {
    this.view = view;
    this.root.hidden = !view.visible;
    if (!view.visible) { this.toggleMenu(false); return; }

    const { main } = view;
    this.main.dataset.tone = main.tone;
    if (this.mainLabel.textContent !== main.label) this.mainLabel.textContent = main.label;
    this.main.title = main.title ?? '';
    this.mainFill.style.width = main.progress == null ? '0' : `${Math.round(Math.max(0, Math.min(1, main.progress)) * 100)}%`;

    const panelSig = view.panel ? JSON.stringify([view.panel.tone, view.panel.title, view.panel.detail, view.panel.actions.map((a) => a.label)]) : '';
    if (panelSig && panelSig === this.panel.dataset.sig && !this.panel.hidden) {
      // Unchanged: keep the DOM (and keyboard focus) as it is.
    } else if (view.panel) {
      const { panel } = view;
      this.panel.dataset.sig = panelSig;
      this.panel.dataset.tone = panel.tone;
      this.panel.setAttribute('role', panel.tone === 'error' ? 'alert' : 'status');
      this.panel.replaceChildren(
        h('strong', { class: 'll-panel-title' }, panel.title),
        h('span', { class: 'll-panel-detail', hidden: !panel.detail }, panel.detail),
        h('div', { class: 'll-panel-actions' },
          panel.actions.map((a) => h('button', { class: 'll-chip-btn', type: 'button', 'data-primary': a.primary ? '' : null, onclick: a.run }, a.label))),
      );
      this.panel.hidden = false;
    } else {
      this.panel.hidden = true;
      this.panel.dataset.sig = '';
    }
    if (!this.menu.hidden) this.renderMenu();
  }

  private renderMenu(): void {
    const items = this.view?.menu ?? [];
    this.menu.replaceChildren(...items.map((item) => item === 'sep'
      ? h('div', { class: 'll-menu-sep', role: 'separator' })
      : h('button', {
        class: 'll-menu-item',
        type: 'button',
        role: 'menuitem',
        'data-danger': item.danger ? '' : null,
        onclick: () => { this.toggleMenu(false); item.run(); },
      }, item.label, item.hint ? h('small', null, item.hint) : null)));
  }

  toggleMenu(force?: boolean): void {
    const show = force ?? this.menu.hidden;
    if (show) this.renderMenu();
    this.menu.hidden = !show;
    this.moreButton.setAttribute('aria-expanded', String(show));
    if (show) (this.menu.querySelector('.ll-menu-item') as HTMLElement | null)?.focus();
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string, ms = 2600): void {
  let el = document.querySelector<HTMLElement>('.ll-toast');
  if (!el) {
    el = h('div', { class: 'll-root ll-toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.dataset.show = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (el) el.dataset.show = ''; }, ms);
}
