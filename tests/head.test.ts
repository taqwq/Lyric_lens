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
  tone: 'speaking',
  status: '',
  captions: [],
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

describe('止める right after the button just pressed', () => {
  let now = 1_000;
  beforeEach(() => {
    now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    document.body.innerHTML = `<div data-lyrics-container="true">[Chorus]<br>Pull up in the rain, I ain't even need a coat<br>Light under the door</div>`;
    page = readPage()!;
    head = new HeadRow();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const s2 = (): HeadView => ({
    tone: 'speaking',
    captions: [],
    status: '',
    state: 'S2',
    actions: [{ id: 'start', label: '日本語で読む', onClick: vi.fn(), primary: true }, { id: 'settings', label: '設定', onClick: vi.fn() }],
  });
  const s3 = (onClick = vi.fn()): HeadView => ({ tone: 'speaking', captions: [], status: '曲全体を読んでいます', state: 'S3', actions: [{ id: 'stop', label: '止める', onClick }] });
  const s4 = (onClick = vi.fn()): HeadView => ({
    tone: 'speaking',
    captions: [],
    status: '訳しています',
    state: 'S4',
    actions: [{ id: 'stop', label: '止める', onClick }, { id: 'hide', label: '訳を隠す', onClick: vi.fn() }, { id: 'settings', label: '設定', onClick: vi.fn() }],
  });
  const stopButton = () => head.element!.querySelector<HTMLButtonElement>('.ll-head-row .ll-btn')!;

  it('moves focus to the status line, ignores a tap at +200 ms and accepts one at +700 ms', () => {
    head.render(page, s2());
    stopButton().focus();
    expect(document.activeElement).toBe(stopButton());

    const spy = vi.fn();
    head.render(page, s3(spy));
    expect(document.activeElement).toBe(statusOf());
    expect(statusOf().getAttribute('tabindex')).toBe('-1');

    now += 200;
    stopButton().click();
    expect(spy).not.toHaveBeenCalled();

    now += 500;
    stopButton().click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not restart when S3 turns into S4: a stop right at the first line works', () => {
    head.render(page, s2());
    head.render(page, s3());
    now += 10_000;
    const spy = vi.fn();
    head.render(page, s4(spy));
    stopButton().click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on 止める itself when it was already the focused button', () => {
    head.render(page, s3());
    now += 10_000;
    stopButton().focus();
    head.render(page, s4());
    expect(document.activeElement).toBe(stopButton());
  });

  it('clear() forgets the old 止める: a stop shown afterwards counts as new', () => {
    head.render(page, s3());
    now += 10_000;
    head.clear();
    const spy = vi.fn();
    head.render(page, s4(spy));
    now += 100;
    stopButton().click();
    expect(spy).not.toHaveBeenCalled();
    now += 600;
    stopButton().click();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('row content', () => {
  const stopA = { id: 'stop', label: '止める', onClick: vi.fn() };
  const hideA = { id: 'hide', label: '訳を隠す', onClick: vi.fn() };
  const setA = { id: 'settings', label: '設定', onClick: vi.fn() };
  const bar = () => head.element!.querySelector<HTMLElement>('.ll-progress');

  it('the head is a labelled region excluded from selection', () => {
    head.render(page, view({ state: 'S4' }));
    const el = head.element!;
    expect(el.getAttribute('role')).toBe('region');
    expect(el.getAttribute('aria-label')).toBe('Lyric Lens 日本語訳');
    expect(el.getAttribute('lang')).toBe('ja');
    expect(el.dataset.llState).toBe('S4');
    expect(el.hasAttribute('data-exclude-from-selection')).toBe(true);
  });

  it('the row carries data-tone, starts with the aria-hidden icon and then the status', () => {
    head.render(page, view({ status: '読んでいます', actions: [] }));
    const row = head.element!.querySelector<HTMLElement>('.ll-head-row')!;
    expect(row.dataset.tone).toBe('speaking');
    expect(row.firstElementChild!.className).toBe('ll-icon');
    expect(row.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    expect(row.children[1]).toBe(statusOf());
    head.render(page, view({ status: 'AIによる日本語訳', tone: 'settled', actions: [] }));
    expect(head.element!.querySelector<HTMLElement>('.ll-head-row')!.dataset.tone).toBe('settled');
  });

  it('the primary button takes the left; the status stays in the DOM as an empty live region', () => {
    head.render(page, view());
    const row = head.element!.querySelector<HTMLElement>('.ll-head-row')!;
    expect(Array.from(row.children).map((c) => c.className)).toEqual(['ll-icon', 'll-btn', 'll-status']);
    const primary = row.querySelector<HTMLButtonElement>('.ll-btn')!;
    expect(primary.hasAttribute('data-primary')).toBe(true);
    expect(primary.textContent).toBe('日本語で読む');
    expect(statusOf().hasAttribute('data-empty')).toBe(true);
    expect(statusOf().textContent).toBe('');
  });

  it('the count is aria-hidden and only present with a count; links keep their order inside .ll-links', () => {
    head.render(page, view({ status: '訳しています', actions: [stopA, hideA, setA], count: '（12/67行）', progress: { value: 12, max: 67 } }));
    const row = head.element!.querySelector<HTMLElement>('.ll-head-row')!;
    expect(Array.from(row.children).map((c) => c.className)).toEqual(['ll-icon', 'll-status', 'll-count', 'll-links', 'll-progress']);
    const count = row.querySelector('.ll-count')!;
    expect(count.textContent).toBe('（12/67行）');
    expect(count.getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(row.querySelectorAll('.ll-links .ll-btn')).map((b) => b.textContent)).toEqual(['止める', '訳を隠す', '設定']);
    expect(row.querySelector('.ll-links [data-primary]')).toBeNull();
    head.render(page, view({ status: 'AIによる日本語訳', actions: [hideA, setA] }));
    expect(head.element!.querySelector('.ll-count')).toBeNull();
    expect(bar()).toBeNull();
  });

  it('progress is a progressbar with value, max and --p, updated in place without a rebuild', () => {
    head.render(page, view({ status: '訳しています', actions: [stopA], progress: { value: 12, max: 67 } }));
    const first = bar()!;
    expect(first.getAttribute('role')).toBe('progressbar');
    expect(first.getAttribute('aria-label')).toBe('翻訳の進み具合');
    expect(first.getAttribute('aria-valuemin')).toBe('0');
    expect(first.getAttribute('aria-valuemax')).toBe('67');
    expect(first.getAttribute('aria-valuenow')).toBe('12');
    expect(first.style.getPropertyValue('--p')).toBe('0.179');
    expect(first.hasAttribute('data-indeterminate')).toBe(false);
    head.render(page, view({ status: '訳しています', actions: [stopA], progress: { value: 40, max: 67 } }));
    expect(bar()).toBe(first);
    expect(first.getAttribute('aria-valuenow')).toBe('40');
    expect(first.style.getPropertyValue('--p')).toBe('0.597');
  });

  it('an indeterminate bar has no values; null removes the bar', () => {
    head.render(page, view({ status: '曲全体を読んでいます', actions: [stopA], progress: 'indeterminate' }));
    const b = bar()!;
    expect(b.hasAttribute('data-indeterminate')).toBe(true);
    expect(b.getAttribute('role')).toBe('progressbar');
    expect(b.getAttribute('aria-label')).toBe('翻訳の進み具合');
    expect(b.hasAttribute('aria-valuenow')).toBe(false);
    expect(b.hasAttribute('aria-valuemax')).toBe(false);
    head.render(page, view({ status: 'x', actions: [stopA], progress: null }));
    expect(bar()).toBeNull();
  });

  it('the count text changes in place', () => {
    head.render(page, view({ status: '訳しています', actions: [stopA], count: '（1/9行）' }));
    const count = head.element!.querySelector('.ll-count')!;
    head.render(page, view({ status: '訳しています', actions: [stopA], count: '（2/9行）' }));
    expect(head.element!.querySelector('.ll-count')).toBe(count);
    expect(count.textContent).toBe('（2/9行）');
  });

  it('captions follow the row in order, with data-tone only for a reason', () => {
    head.render(page, view({ captions: [{ text: '67行のうち31行まで訳してあります' }, { text: '別の曲を訳し終えると続きを訳せます', tone: 'reason' }] }));
    const caps = Array.from(head.element!.querySelectorAll<HTMLElement>('.ll-caption'));
    expect(caps.map((c) => c.textContent)).toEqual(['67行のうち31行まで訳してあります', '別の曲を訳し終えると続きを訳せます']);
    expect(caps[0]!.hasAttribute('data-tone')).toBe(false);
    expect(caps[1]!.dataset.tone).toBe('reason');
    expect(head.element!.children[1]).toBe(caps[0]);
    head.render(page, view({ captions: [] }));
    expect(head.element!.querySelector('.ll-caption')).toBeNull();
  });

  it('carries none of the old labels or classes', () => {
    head.render(page, view({ preface: { who: 'AからBへ', what: '本文', collapsed: false, onToggle: vi.fn() } }));
    const text = head.element!.textContent!;
    expect(text).not.toContain('誰が誰に');
    expect(text).not.toContain('この曲は');
    expect(head.element!.querySelector('.ll-head-note, .ll-actions, .ll-preface-label, .ll-preface-toggle')).toBeNull();
  });
});

describe('preface', () => {
  const pf = (collapsed: boolean, onToggle = vi.fn()) => ({ who: 'ケンドリックから、ライバルと聴衆へ', what: '圧倒的な成功と孤独の歌', collapsed, onToggle });

  it('expanded: both paragraphs, no toggle at all', () => {
    head.render(page, view({ preface: pf(false) }));
    const who = head.element!.querySelector<HTMLElement>('.ll-preface-who')!;
    const what = head.element!.querySelector<HTMLElement>('.ll-preface-what')!;
    expect(who.tagName).toBe('P');
    expect(who.textContent).toBe('ケンドリックから、ライバルと聴衆へ');
    expect(what.hidden).toBe(false);
    expect(what.textContent).toBe('圧倒的な成功と孤独の歌');
    expect(head.element!.querySelector('.ll-preface-more')).toBeNull();
  });

  it('collapsed: the 続きを読む ▾ toggle ends the first line and controls the hidden second paragraph', () => {
    const onToggle = vi.fn();
    head.render(page, view({ preface: pf(true, onToggle) }));
    const who = head.element!.querySelector<HTMLElement>('.ll-preface-who')!;
    const what = head.element!.querySelector<HTMLElement>('.ll-preface-what')!;
    const more = who.querySelector<HTMLButtonElement>('.ll-preface-more')!;
    expect(more.textContent).toBe('続きを読む ▾');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.getAttribute('aria-controls')).toBe(what.id);
    expect(what.id).toBeTruthy();
    expect(what.hidden).toBe(true);
    expect(who.lastElementChild).toBe(more);
    more.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('expanding removes the toggle and keeps focus inside the head', () => {
    head.render(page, view({ preface: pf(true) }));
    head.element!.querySelector<HTMLButtonElement>('.ll-preface-more')!.focus();
    head.render(page, view({ preface: pf(false) }));
    expect(head.element!.querySelector('.ll-preface-more')).toBeNull();
    expect(head.element!.contains(document.activeElement)).toBe(true);
  });

  it('no preface, no preface node', () => {
    head.render(page, view({ preface: null }));
    expect(head.element!.querySelector('.ll-preface')).toBeNull();
  });
});

describe('settle', () => {
  const rowOf = () => head.element!.querySelector<HTMLElement>('.ll-head-row')!;
  const settled = (over: Partial<HeadView> = {}) => view({ status: 'AIによる日本語訳', tone: 'settled', actions: [], ...over });
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sets data-settle for 600 ms, then removes it', () => {
    head.render(page, settled({ settle: true }));
    expect(rowOf().hasAttribute('data-settle')).toBe(true);
    vi.advanceTimersByTime(599);
    expect(rowOf().hasAttribute('data-settle')).toBe(true);
    vi.advanceTimersByTime(2);
    expect(rowOf().hasAttribute('data-settle')).toBe(false);
  });

  it('survives a rebuild inside the window and does not return afterwards', () => {
    head.render(page, settled({ settle: true }));
    head.render(page, settled({ status: '訳を隠しています' }));
    expect(rowOf().hasAttribute('data-settle')).toBe(true);
    vi.advanceTimersByTime(700);
    expect(rowOf().hasAttribute('data-settle')).toBe(false);
    head.render(page, settled());
    expect(rowOf().hasAttribute('data-settle')).toBe(false);
  });

  it('is absent without view.settle', () => {
    head.render(page, settled());
    expect(rowOf().hasAttribute('data-settle')).toBe(false);
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
    for (const sel of ['.ll-gn-toggle:active', '.ll-gn-more:active', '.ll-preface-more:active']) expect(rule![1]).toContain(sel);
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
