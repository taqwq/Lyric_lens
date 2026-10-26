import './setup';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPage, type PageSong } from '../src/genius/extract';
import { HeadRow, type HeadView } from '../src/ui/head';

const GENIUS = '<div data-lyrics-container="true">[Verse 1]<br>Walking down the empty hall<br>Light under the door</div>';

let page: PageSong;
let head: HeadRow;

beforeEach(() => {
  document.body.innerHTML = GENIUS;
  page = readPage()!;
  head = new HeadRow();
});

afterEach(() => {
  document.body.innerHTML = '';
});

const view = (over: Partial<HeadView> = {}): HeadView => ({
  status: '',
  actions: [{ id: 'start', label: '日本語で読む', onClick: vi.fn(), primary: true }],
  ...over,
});
const statusOf = () => head.element!.querySelector<HTMLElement>('[role=status]')!;

describe('status live region', () => {
  it('is one node that survives every rebuild, so its text changes in place', () => {
    head.render(page, view({ status: '' }));
    const first = statusOf();
    expect(first).not.toBeNull();

    head.render(page, view({ status: '曲全体を読んでいます' }));
    const second = statusOf();
    expect(second).toBe(first);
    expect(second.textContent).toBe('曲全体を読んでいます');
    expect(second.getAttribute('aria-live')).toBe('polite');

    // Same view again: no rebuild, same node, same text.
    head.render(page, view({ status: '曲全体を読んでいます' }));
    expect(statusOf()).toBe(first);
    expect(statusOf().textContent).toBe('曲全体を読んでいます');

    // Back to empty: still in the DOM (never `hidden`), flagged for the CSS to collapse it.
    head.render(page, view({ status: '' }));
    const last = statusOf();
    expect(last).toBe(first);
    expect(last.isConnected).toBe(true);
    expect(last.textContent).toBe('');
    expect(last.hasAttribute('data-empty')).toBe(true);
    expect(last.hasAttribute('hidden')).toBe(false);
  });

  it('is only marked empty while it is empty', () => {
    head.render(page, view({ status: '' }));
    expect(statusOf().hasAttribute('data-empty')).toBe(true);
    head.render(page, view({ status: '読んでいます' }));
    expect(statusOf().hasAttribute('data-empty')).toBe(false);
    expect(statusOf().hasAttribute('hidden')).toBe(false);
    head.render(page, view({ status: '' }));
    expect(statusOf().hasAttribute('data-empty')).toBe(true);
  });

  it('data-tone follows view.tone, defaulting to normal', () => {
    head.render(page, view({ status: '読んでいます' }));
    expect(statusOf().dataset.tone).toBe('normal');
    head.render(page, view({ status: '読んでいます', tone: 'muted' }));
    expect(statusOf().dataset.tone).toBe('muted');
    head.render(page, view({ status: '読んでいます', tone: 'normal' }));
    expect(statusOf().dataset.tone).toBe('normal');
  });

  it('sits first in the row and the row keeps data-bare for an empty status', () => {
    head.render(page, view({ status: '' }));
    const row = head.element!.querySelector<HTMLElement>('.ll-head-row')!;
    expect(row.firstElementChild).toBe(statusOf());
    expect(row.dataset.bare).toBe('1');
    head.render(page, view({ status: '読んでいます' }));
    const next = head.element!.querySelector<HTMLElement>('.ll-head-row')!;
    expect(next.firstElementChild).toBe(statusOf());
    expect(next.dataset.bare).toBe('');
  });

  it('clear() forgets the node: a later render makes a fresh one', () => {
    head.render(page, view({ status: '読んでいます' }));
    const old = statusOf();
    head.clear();
    expect(head.element).toBeNull();
    head.render(page, view({ status: '読んでいます' }));
    expect(statusOf()).not.toBe(old);
    expect(statusOf().textContent).toBe('読んでいます');
  });
});

describe('styles.css (touch feedback)', () => {
  const css = readFileSync(resolve(__dirname, '../src/ui/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('.ll-btn:hover applies only inside @media (hover: hover)', () => {
    const at = (needle: string) => {
      const found: number[] = [];
      for (let i = css.indexOf(needle); i >= 0; i = css.indexOf(needle, i + 1)) found.push(i);
      return found;
    };
    const hovers = at('.ll-btn:hover');
    expect(hovers.length).toBeGreaterThan(0);
    for (const i of hovers) {
      const media = css.lastIndexOf('@media', i);
      expect(media).toBeGreaterThanOrEqual(0);
      expect(css.slice(media, css.indexOf('{', media) + 1)).toMatch(/^@media \(hover: hover\) \{$/);
      const between = css.slice(media, i);
      // Still inside the at-rule: exactly the media block is open.
      expect((between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length).toBe(1);
    }
    // The disabled rule comes after, so disabled buttons keep text-decoration: none.
    expect(css.indexOf('.ll-btn:disabled')).toBeGreaterThan(hovers[hovers.length - 1]!);
  });

  it('pressed controls dim to .55 at once (no transition)', () => {
    const rule = /(?:^|\})\s*([^{}]*\.ll-btn:active:not\(:disabled\)[^{}]*)\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    for (const sel of ['.ll-gn-toggle:active', '.ll-gn-more:active', '.ll-preface-toggle:active']) expect(rule![1]).toContain(sel);
    expect(rule![2]).toMatch(/opacity:\s*\.55\b/);
    expect(rule![2]).not.toMatch(/transition/);
    expect(css.indexOf('.ll-btn:active:not(:disabled)')).toBeGreaterThan(css.indexOf('.ll-btn:disabled'));
    expect(css).toContain('-webkit-tap-highlight-color: transparent');
  });

  it('an empty status region is collapsed, never display: none', () => {
    const rule = /\.ll-status\[data-empty\]\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/display:\s*block/);
    expect(rule![1]).not.toMatch(/display:\s*none/);
    expect(rule![1]).toMatch(/width:\s*0\b/);
    expect(rule![1]).toMatch(/height:\s*0\b/);
    expect(rule![1]).toMatch(/overflow:\s*hidden/);
  });
});
