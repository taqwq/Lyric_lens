import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineResult, Note, SongRecord } from '../src/core/types';
import { readPage, type PageSong } from '../src/genius/extract';
import { LineRenderer, type LinesInput, type SeamView } from '../src/ui/lines';

/* Lines (index): 0 "I walk alone"  1 "Through the night"  2 "I walk alone" (repeat of 0)
 *                3 "Hold on tight (Hold on, hold on)"  4 "Dream on"  5 "Wake up" (no trailing <br>). */
const GENIUS =
  '<div data-lyrics-container="true">' +
  '[Verse 1]<br>' +
  'I walk alone<br>' +
  '<a href="/1"><span>Through the night</span></a><br>' +
  'I walk alone<br>' +
  'Hold on tight (Hold on, hold on)<br>' +
  'Dream on<br>' +
  '[Chorus]<br>' +
  'Wake up' +
  '</div>';

const SMALLER =
  '<div data-lyrics-container="true">' +
  '[Verse 1]<br>I walk alone<br>Through the night<br>Hold on tight (Hold on, hold on)<br>Dream on' +
  '</div>';

let page: PageSong;

beforeEach(() => {
  document.body.innerHTML = GENIUS;
  page = readPage()!;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function record(p: PageSong, entries: Record<number, string | LineResult>): SongRecord {
  const lines: Record<string, LineResult> = {};
  for (const [i, value] of Object.entries(entries)) lines[p.source.lines[Number(i)]!.key] = typeof value === 'string' ? { ja: value } : value;
  return { v: 2, id: 's1', path: p.path, title: 't', artist: 'a', lines, createdAt: 0, updatedAt: 0 };
}

function input(p: PageSong, over: Partial<LinesInput> = {}): LinesInput {
  return { page: p, record: null, slots: false, gaps: false, breathing: false, seam: null, animate: false, openIndex: null, onMark: vi.fn(), ...over };
}

const states = (r: LineRenderer, p: PageSong) => p.source.lines.map((_, i) => r.nodeFor(i)?.dataset.state ?? null);
const llLines = () => Array.from(document.querySelectorAll<HTMLElement>('.ll-line'));
const seamOf = (over: Partial<SeamView['button']> = {}, text = 'ここで止めました'): SeamView => ({ text, button: { label: '続きを訳す', onClick: vi.fn(), ...over } });

const slangNote: Note = { kind: 'slang', phrase: 'Dream on', text: 'ほげ' };
const idiomNote: Note = { kind: 'idiom', phrase: 'Wake up', text: 'ふが' };

describe('fixture', () => {
  it('reads the Genius-like page into six lines, line 2 a repeat of line 0', () => {
    expect(page.source.lines.map((l) => l.text)).toEqual(['I walk alone', 'Through the night', 'I walk alone', 'Hold on tight (Hold on, hold on)', 'Dream on', 'Wake up']);
    expect(page.source.lines.map((l) => l.occurrence)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(page.anchors).toHaveLength(6);
  });
});

describe('states', () => {
  it('draws nothing when there are no slots, gaps, seam or translations', () => {
    const r = new LineRenderer();
    r.render(input(page));
    expect(llLines()).toHaveLength(0);
    expect(states(r, page)).toEqual([null, null, null, null, null, null]);
  });

  it('slots: every missing line is an empty ruled slot', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    expect(states(r, page)).toEqual(['empty', 'empty', 'empty', 'empty', 'empty', 'empty']);
    for (const el of llLines()) expect(el.querySelector('.ll-ja')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('breathing: the first empty slot is `next`', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true, breathing: true }));
    expect(states(r, page)).toEqual(['next', 'empty', 'empty', 'empty', 'empty', 'empty']);
  });

  it('filled lines show their translation; everything after the last filled line waits', () => {
    const r = new LineRenderer();
    // Filling "I walk alone" fills lines 0 and 2 (same key) and line 1.
    r.render(input(page, { record: record(page, { 0: 'ひとり歩く', 1: '夜を抜けて' }), slots: true, breathing: true }));
    expect(states(r, page)).toEqual(['filled', 'filled', 'filled', 'next', 'empty', 'empty']);
    expect(r.nodeFor(0)!.querySelector('.ll-ja')!.textContent).toBe('ひとり歩く');
    expect(r.nodeFor(2)!.querySelector('.ll-ja')!.textContent).toBe('ひとり歩く');
    expect(r.nodeFor(1)!.querySelector('.ll-ja')!.textContent).toBe('夜を抜けて');
  });

  it('filled lines stay on the page even when slots are off', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 1: '夜を抜けて' }) }));
    expect(states(r, page)).toEqual([null, 'filled', null, null, null, null]);
    expect(llLines()).toHaveLength(1);
  });

  it('a line with an empty `ja` is not filled', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 1: '' }), slots: true }));
    expect(states(r, page)).toEqual(['empty', 'empty', 'empty', 'empty', 'empty', 'empty']);
  });

  it('gaps: missing lines read as a quiet "—", filled lines stay', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 0: 'ひとり歩く', 4: '夢を見て' }), gaps: true }));
    expect(states(r, page)).toEqual(['filled', 'gap', 'filled', 'gap', 'filled', 'gap']);
    const gap = r.nodeFor(1)!.querySelector('.ll-ja')!;
    expect(gap.textContent).toBe('—');
    expect(gap.getAttribute('aria-label')).toBe('まだ訳せていない行');
    // aria-label on a generic span is ignored by VoiceOver/TalkBack: the span is an image.
    expect(gap.getAttribute('role')).toBe('img');
    // A translated line's text is plain text, not an image.
    expect(r.nodeFor(0)!.querySelector('.ll-ja')!.hasAttribute('role')).toBe(false);
  });

  it('gaps beat slots', () => {
    const r = new LineRenderer();
    r.render(input(page, { gaps: true, slots: true, breathing: true }));
    expect(states(r, page)).toEqual(['gap', 'gap', 'gap', 'gap', 'gap', 'gap']);
  });

  it('seam: replaces the first missing line only', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 0: 'ひとり歩く', 1: '夜を抜けて' }), slots: true, seam: seamOf() }));
    expect(states(r, page)).toEqual(['filled', 'filled', 'filled', 'seam', 'empty', 'empty']);
    const seam = r.nodeFor(3)!.querySelector('.ll-seam')!;
    expect(seam.querySelector('.ll-seam-text')!.textContent).toBe('ここで止めました');
    expect(seam.querySelector('button.ll-btn')!.textContent).toBe('続きを訳す');
  });

  it('seam with nothing translated sits at line 1', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true, seam: seamOf() }));
    expect(states(r, page)).toEqual(['seam', 'empty', 'empty', 'empty', 'empty', 'empty']);
  });

  it('a seam is drawn even when slots are off', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 1: '夜を抜けて' }), seam: seamOf() }));
    expect(states(r, page)).toEqual([null, 'filled', 'seam', null, null, null]);
  });

  it('every line filled: nothing but translations', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 0: 'a', 1: 'b', 3: 'c', 4: 'd', 5: 'e' }), slots: true, breathing: true, seam: seamOf() }));
    expect(states(r, page)).toEqual(['filled', 'filled', 'filled', 'filled', 'filled', 'filled']);
  });

  it('each translation sits directly after the node that ends its line', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    page.source.lines.forEach((_, i) => {
      const el = r.nodeFor(i)!;
      expect(el.previousSibling).toBe(page.anchors[i]);
      expect(el.isConnected).toBe(true);
    });
    // The last line has no <br>: its slot is appended after the text node.
    expect(page.anchors[5]!.nodeType).toBe(3);
    expect(r.nodeFor(5)!.previousSibling).toBe(page.anchors[5]);
  });

  it('nodes are excluded from selection and marked Japanese', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    const el = r.nodeFor(0)!;
    expect(el.tagName).toBe('SPAN');
    expect(el.className).toBe('ll-line');
    expect(el.getAttribute('lang')).toBe('ja');
    expect(el.getAttribute('data-exclude-from-selection')).toBe('true');
  });

  it('an empty slot becomes filled in place (same node)', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    const before = r.nodeFor(1)!;
    r.render(input(page, { slots: true, record: record(page, { 1: '夜を抜けて' }) }));
    expect(r.nodeFor(1)).toBe(before);
    expect(before.dataset.state).toBe('filled');
  });
});

describe('the frontier rule', () => {
  it('a hole before the last filled line renders as gap while slots are on', () => {
    const r = new LineRenderer();
    // Filled: 0, 2 ("I walk alone") and 4. Missing 1 and 3 are holes the model skipped.
    r.render(input(page, { record: record(page, { 0: 'ひとり歩く', 4: '夢を見て' }), slots: true }));
    expect(states(r, page)).toEqual(['filled', 'gap', 'filled', 'gap', 'filled', 'empty']);
  });

  it('`next` sits at the first missing line AFTER the last filled one, not at the first hole', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 0: 'ひとり歩く', 4: '夢を見て' }), slots: true, breathing: true }));
    expect(states(r, page)).toEqual(['filled', 'gap', 'filled', 'gap', 'filled', 'next']);
  });

  it('the seam sits at that same frontier, holes before it stay gaps', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 0: 'ひとり歩く', 4: '夢を見て' }), slots: true, seam: seamOf() }));
    expect(states(r, page)).toEqual(['filled', 'gap', 'filled', 'gap', 'filled', 'seam']);
  });

  it('when only the last line is filled the frontier falls back to the first missing line', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 5: '起きて' }), slots: true, breathing: true }));
    // Nothing is missing after line 5, so the first missing line overall is the frontier; no
    // line is "before the frontier and before the last filled one" in the gap sense.
    expect(states(r, page)).toEqual(['next', 'empty', 'empty', 'empty', 'empty', 'filled']);
  });

  it('the fallback frontier takes the seam too', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 5: '起きて' }), slots: true, seam: seamOf() }));
    expect(states(r, page)).toEqual(['seam', 'empty', 'empty', 'empty', 'empty', 'filled']);
  });

  it('with slots off, holes before the last filled line are not drawn at all', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 0: 'ひとり歩く', 4: '夢を見て' }) }));
    expect(states(r, page)).toEqual(['filled', null, 'filled', null, 'filled', null]);
  });

  it('the frontier moves forward as lines arrive', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true, breathing: true }));
    expect(states(r, page)).toEqual(['next', 'empty', 'empty', 'empty', 'empty', 'empty']);
    r.render(input(page, { slots: true, breathing: true, record: record(page, { 0: 'a', 1: 'b' }) }));
    expect(states(r, page)).toEqual(['filled', 'filled', 'filled', 'next', 'empty', 'empty']);
    r.render(input(page, { slots: true, breathing: true, record: record(page, { 0: 'a', 1: 'b', 3: 'c' }) }));
    expect(states(r, page)).toEqual(['filled', 'filled', 'filled', 'filled', 'next', 'empty']);
  });

  // A repeat is filled the moment its first occurrence arrives, ahead of unique lines not yet
  // written above it (a chorus before verse 2): only first occurrences move the frontier.
  it('a repeat filled ahead of the writing position does not move `next`', () => {
    const r = new LineRenderer();
    // Only unique line 1 ("I walk alone") has arrived: it filled lines 0 and 2.
    r.render(input(page, { record: record(page, { 0: 'ひとり歩く' }), slots: true, breathing: true }));
    expect(states(r, page)).toEqual(['filled', 'next', 'filled', 'empty', 'empty', 'empty']);
  });

  it('a repeat filled ahead of the stop does not move the seam', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 0: 'ひとり歩く' }), slots: true, seam: seamOf() }));
    expect(states(r, page)).toEqual(['filled', 'seam', 'filled', 'empty', 'empty', 'empty']);
  });
});

describe('repeats', () => {
  it('a repeated line carries data-repeat and ↺ once filled', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 0: 'ひとり歩く' }), slots: true }));
    const first = r.nodeFor(0)!;
    const repeat = r.nodeFor(2)!;
    expect(first.hasAttribute('data-repeat')).toBe(false);
    expect(first.querySelector('.ll-repeat')).toBeNull();
    expect(repeat.hasAttribute('data-repeat')).toBe(true);
    const mark = repeat.querySelector('.ll-repeat')!;
    expect(mark.textContent).toBe('↺');
    expect(mark.getAttribute('aria-label')).toBe('くり返し');
    expect(mark.getAttribute('role')).toBe('img');
    expect(repeat.querySelector('.ll-ja')!.textContent).toBe('ひとり歩く');
    expect(repeat.querySelector('.ll-ja')!.hasAttribute('role')).toBe(false);
  });

  it('an empty slot for a repeat has data-repeat but no ↺', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    expect(r.nodeFor(2)!.hasAttribute('data-repeat')).toBe(true);
    expect(r.nodeFor(2)!.querySelector('.ll-repeat')).toBeNull();
    expect(r.nodeFor(0)!.hasAttribute('data-repeat')).toBe(false);
  });

  it('only the repeated occurrence is marked', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 0: 'a', 1: 'b', 3: 'c', 4: 'd', 5: 'e' }) }));
    expect(page.source.lines.map((_, i) => r.nodeFor(i)!.hasAttribute('data-repeat'))).toEqual([false, false, true, false, false, false]);
    expect(llLines().filter((el) => el.querySelector('.ll-repeat'))).toHaveLength(1);
  });
});

describe('※ notes', () => {
  it('appears only on lines that have notes', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 0: 'a', 4: { ja: 'd', notes: [slangNote] }, 5: { ja: 'e', notes: [] } }) }));
    expect(r.nodeFor(0)!.querySelector('.ll-mark')).toBeNull();
    expect(r.nodeFor(5)!.querySelector('.ll-mark')).toBeNull();
    const mark = r.nodeFor(4)!.querySelector('.ll-mark')!;
    expect(mark.tagName).toBe('BUTTON');
    expect(mark.textContent).toBe('※');
    expect(mark.getAttribute('aria-label')).toBe('注：スラング「Dream on」');
    expect(mark.getAttribute('aria-expanded')).toBe('false');
  });

  it('an empty slot never shows ※', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    expect(document.querySelector('.ll-mark')).toBeNull();
  });

  it('several notes read 注 N件', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 4: { ja: 'd', notes: [slangNote, idiomNote] } }) }));
    expect(r.nodeFor(4)!.querySelector('.ll-mark')!.getAttribute('aria-label')).toBe('注 2件');
  });

  it('aria-expanded follows openIndex without rebuilding the node or the button', () => {
    const r = new LineRenderer();
    const rec = record(page, { 4: { ja: 'd', notes: [slangNote] }, 5: { ja: 'e', notes: [idiomNote] } });
    r.render(input(page, { record: rec }));
    const line4 = r.nodeFor(4)!;
    const line5 = r.nodeFor(5)!;
    const mark4 = line4.querySelector('.ll-mark')!;
    const mark5 = line5.querySelector('.ll-mark')!;
    const ja4 = line4.querySelector('.ll-ja')!;

    r.render(input(page, { record: rec, openIndex: 4 }));
    expect(r.nodeFor(4)).toBe(line4);
    expect(line4.querySelector('.ll-mark')).toBe(mark4);
    expect(line4.querySelector('.ll-ja')).toBe(ja4);
    expect(mark4.getAttribute('aria-expanded')).toBe('true');
    expect(mark5.getAttribute('aria-expanded')).toBe('false');

    r.render(input(page, { record: rec, openIndex: 5 }));
    expect(line4.querySelector('.ll-mark')).toBe(mark4);
    expect(line5.querySelector('.ll-mark')).toBe(mark5);
    expect(mark4.getAttribute('aria-expanded')).toBe('false');
    expect(mark5.getAttribute('aria-expanded')).toBe('true');

    r.render(input(page, { record: rec, openIndex: null }));
    expect(mark4.getAttribute('aria-expanded')).toBe('false');
    expect(mark5.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the same button while the line gets a new neighbour filled', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 4: { ja: 'd', notes: [slangNote] } }) }));
    const mark = r.nodeFor(4)!.querySelector('.ll-mark')!;
    r.render(input(page, { record: record(page, { 1: 'b', 4: { ja: 'd', notes: [slangNote] } }) }));
    expect(r.nodeFor(4)!.querySelector('.ll-mark')).toBe(mark);
  });

  it('rebuilds the line when its notes change (same node, new label)', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 4: { ja: 'd', notes: [slangNote] } }) }));
    const el = r.nodeFor(4)!;
    r.render(input(page, { record: record(page, { 4: { ja: 'd', notes: [slangNote, idiomNote] } }) }));
    expect(r.nodeFor(4)).toBe(el);
    expect(el.querySelector('.ll-mark')!.getAttribute('aria-label')).toBe('注 2件');
  });

  it('clicking ※ reports the line index', () => {
    const r = new LineRenderer();
    const onMark = vi.fn();
    r.render(input(page, { record: record(page, { 4: { ja: 'd', notes: [slangNote] } }), onMark }));
    r.nodeFor(4)!.querySelector<HTMLButtonElement>('.ll-mark')!.click();
    expect(onMark).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('Escape on an expanded ※ closes it (and stops there); on a collapsed one it does nothing', () => {
    const r = new LineRenderer();
    const onMark = vi.fn();
    const rec = record(page, { 4: { ja: 'd', notes: [slangNote] } });
    r.render(input(page, { record: rec, onMark }));
    const mark = r.nodeFor(4)!.querySelector<HTMLButtonElement>('.ll-mark')!;
    const escape = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

    mark.dispatchEvent(escape());
    expect(onMark).not.toHaveBeenCalled();

    r.render(input(page, { record: rec, onMark, openIndex: 4 }));
    const leaked = vi.fn();
    document.addEventListener('keydown', leaked);
    const event = escape();
    mark.dispatchEvent(event);
    document.removeEventListener('keydown', leaked);
    expect(onMark).toHaveBeenCalledExactlyOnceWith(4);
    expect(event.defaultPrevented).toBe(true);
    expect(leaked).not.toHaveBeenCalled();
  });

  it('hover peeking is wired only for a fine pointer', () => {
    const rec = record(page, { 4: { ja: 'd', notes: [slangNote] } });

    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: fine)', media: query }));
    const hover = vi.fn();
    const r = new LineRenderer();
    r.render(input(page, { record: rec, onMarkHover: hover }));
    const mark = r.nodeFor(4)!.querySelector<HTMLButtonElement>('.ll-mark')!;
    mark.dispatchEvent(new MouseEvent('mouseenter'));
    mark.dispatchEvent(new MouseEvent('mouseleave'));
    expect(hover.mock.calls).toEqual([[4, true], [4, false]]);

    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
    const coarse = vi.fn();
    const r2 = new LineRenderer();
    r2.render(input(page, { record: rec, onMarkHover: coarse }));
    const mark2 = r2.nodeFor(4)!.querySelector<HTMLButtonElement>('.ll-mark')!;
    mark2.dispatchEvent(new MouseEvent('mouseenter'));
    expect(coarse).not.toHaveBeenCalled();
  });
});

describe('ad-libs', () => {
  it('a trailing （…） group renders inside span.ll-adlib', () => {
    const r = new LineRenderer();
    const ja = 'しっかりつかまって（待って、待って）';
    r.render(input(page, { record: record(page, { 3: ja }) }));
    const body = r.nodeFor(3)!.querySelector('.ll-ja')!;
    const adlib = body.querySelector('span.ll-adlib')!;
    expect(adlib.textContent).toBe('（待って、待って）');
    expect(body.textContent).toBe(ja);
    expect(body.firstChild!.textContent).toBe('しっかりつかまって');
  });

  it('several trailing groups stay together in one ll-adlib', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 3: 'しっかりつかまって（待って）（待って）' }) }));
    const adlibs = r.nodeFor(3)!.querySelectorAll('.ll-adlib');
    expect(adlibs).toHaveLength(1);
    expect(adlibs[0]!.textContent).toBe('（待って）（待って）');
  });

  it('a line whose English has no trailing ad-lib never gets one, even with （…） in the Japanese', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 1: '夜を抜けて（ね）' }) }));
    expect(r.nodeFor(1)!.querySelector('.ll-adlib')).toBeNull();
    expect(r.nodeFor(1)!.querySelector('.ll-ja')!.textContent).toBe('夜を抜けて（ね）');
  });

  it('a Japanese line that is only an ad-lib stays whole', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 3: '（待って、待って）' }) }));
    expect(r.nodeFor(3)!.querySelector('.ll-adlib')).toBeNull();
    expect(r.nodeFor(3)!.querySelector('.ll-ja')!.textContent).toBe('（待って、待って）');
  });

  it('a （…） group in the middle of the Japanese is not an ad-lib tail', () => {
    const r = new LineRenderer();
    r.render(input(page, { record: record(page, { 3: 'しっかり（待って）つかまって' }) }));
    expect(r.nodeFor(3)!.querySelector('.ll-adlib')).toBeNull();
  });
});

describe('the seam button', () => {
  it('reflects `disabled` and rebuilds when the seam changes', () => {
    const r = new LineRenderer();
    const rec = record(page, { 0: 'a', 1: 'b' });
    r.render(input(page, { record: rec, slots: true, seam: seamOf({ disabled: true }) }));
    const el = r.nodeFor(3)!;
    expect(el.querySelector<HTMLButtonElement>('.ll-btn')!.disabled).toBe(true);

    r.render(input(page, { record: rec, slots: true, seam: seamOf({ disabled: false }) }));
    expect(r.nodeFor(3)).toBe(el);
    expect(el.querySelector<HTMLButtonElement>('.ll-btn')!.disabled).toBe(false);

    r.render(input(page, { record: rec, slots: true, seam: seamOf({ disabled: false }, '接続が切れました') }));
    expect(el.querySelector('.ll-seam-text')!.textContent).toBe('接続が切れました');
  });

  it('a tap calls onClick once and disables the button; a disabled button does nothing', () => {
    const r = new LineRenderer();
    const onClick = vi.fn();
    r.render(input(page, { slots: true, seam: seamOf({ onClick }) }));
    const button = r.nodeFor(0)!.querySelector<HTMLButtonElement>('.ll-btn')!;
    button.click();
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);

    const idle = vi.fn();
    const r2 = new LineRenderer();
    r2.render(input(page, { slots: true, seam: seamOf({ onClick: idle, disabled: true }) }));
    r2.nodeFor(0)!.querySelector<HTMLButtonElement>('.ll-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(idle).not.toHaveBeenCalled();
  });

  it('the seam disappears when the seam input goes away and the slot returns', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true, seam: seamOf() }));
    expect(r.nodeFor(0)!.dataset.state).toBe('seam');
    r.render(input(page, { slots: true }));
    expect(r.nodeFor(0)!.dataset.state).toBe('empty');
    expect(document.querySelector('.ll-seam')).toBeNull();
  });
});

describe('fade-in', () => {
  it('a slot that gets filled while animating is inked for 260 ms', () => {
    vi.useFakeTimers();
    const r = new LineRenderer();
    r.render(input(page, { slots: true, breathing: true, animate: true }));
    r.render(input(page, { slots: true, breathing: true, animate: true, record: record(page, { 0: 'a' }) }));
    const el = r.nodeFor(0)!;
    expect(el.hasAttribute('data-ink')).toBe(true);
    vi.advanceTimersByTime(259);
    expect(el.hasAttribute('data-ink')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute('data-ink')).toBe(false);
  });

  it('never inks when animation is off, or for a line drawn filled straight away (cached render)', () => {
    vi.useFakeTimers();
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    r.render(input(page, { slots: true, animate: false, record: record(page, { 0: 'a' }) }));
    expect(r.nodeFor(0)!.hasAttribute('data-ink')).toBe(false);

    const fresh = new LineRenderer();
    document.querySelectorAll('.ll-line').forEach((n) => n.remove());
    fresh.render(input(page, { animate: true, record: record(page, { 1: 'b' }) }));
    expect(fresh.nodeFor(1)!.hasAttribute('data-ink')).toBe(false);
  });
});

describe('re-rendering', () => {
  it('is idempotent: same nodes, same HTML, no duplicates', () => {
    const r = new LineRenderer();
    const rec = record(page, { 0: 'ひとり歩く', 4: { ja: '夢を見て', notes: [slangNote] } });
    const run = () => r.render(input(page, { record: rec, slots: true, breathing: true, seam: seamOf() }));

    run();
    const nodes = page.source.lines.map((_, i) => r.nodeFor(i)!);
    const html = page.containers[0]!.innerHTML;
    const bodies = nodes.map((n) => n.querySelector('.ll-ja'));

    run();
    run();
    expect(page.source.lines.map((_, i) => r.nodeFor(i))).toEqual(nodes);
    nodes.forEach((n, i) => expect(r.nodeFor(i)).toBe(n));
    nodes.forEach((n, i) => expect(n.querySelector('.ll-ja')).toBe(bodies[i]));
    expect(page.containers[0]!.innerHTML).toBe(html);
    expect(llLines()).toHaveLength(6);
  });

  it('a second renderer replaces the first one’s nodes without leaving duplicates', () => {
    const first = new LineRenderer();
    first.render(input(page, { slots: true }));
    const old = llLines();
    expect(old).toHaveLength(6);

    const second = new LineRenderer();
    second.render(input(page, { slots: true }));
    expect(llLines()).toHaveLength(6);
    for (const n of old) expect(n.isConnected).toBe(false);
    page.source.lines.forEach((_, i) => expect(second.nodeFor(i)!.previousSibling).toBe(page.anchors[i]));
  });

  it('removes orphan .ll-line nodes in the containers (also nested), keeps its own', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    const container = page.containers[0]!;
    const orphan = document.createElement('span');
    orphan.className = 'll-line';
    container.appendChild(orphan);
    const holder = document.createElement('span');
    const nested = document.createElement('span');
    nested.className = 'x ll-line';
    holder.appendChild(nested);
    container.appendChild(holder);

    r.render(input(page, { slots: true }));
    expect(orphan.isConnected).toBe(false);
    expect(nested.isConnected).toBe(false);
    expect(llLines()).toHaveLength(6);
    page.source.lines.forEach((_, i) => expect(r.nodeFor(i)!.isConnected).toBe(true));
  });

  it('removes a node when its line stops being drawn', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    expect(llLines()).toHaveLength(6);
    r.render(input(page));
    expect(llLines()).toHaveLength(0);
    expect(r.nodeFor(0)).toBeUndefined();
    // And it comes back as a fresh node when slots return.
    r.render(input(page, { slots: true }));
    expect(llLines()).toHaveLength(6);
  });

  it('puts a displaced node back right after its anchor', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    const el = r.nodeFor(1)!;
    page.containers[0]!.appendChild(el);
    expect(el.previousSibling).not.toBe(page.anchors[1]);
    r.render(input(page, { slots: true }));
    expect(r.nodeFor(1)).toBe(el);
    expect(el.previousSibling).toBe(page.anchors[1]);
    expect(llLines()).toHaveLength(6);
  });

  it('survives Genius re-rendering the lyrics: damaged() flags it, the next render repairs it', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    expect(r.damaged()).toBe(false);

    document.body.innerHTML = GENIUS;
    expect(r.damaged()).toBe(true);

    const reread = readPage()!;
    r.render(input(reread, { slots: true }));
    expect(r.damaged()).toBe(false);
    expect(llLines()).toHaveLength(6);
    reread.source.lines.forEach((_, i) => expect(r.nodeFor(i)!.previousSibling).toBe(reread.anchors[i]));
  });

  it('drops the nodes of lines that no longer exist when the lyrics shrink', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    expect(llLines()).toHaveLength(6);

    document.body.innerHTML = SMALLER;
    const smaller = readPage()!;
    expect(smaller.source.lines).toHaveLength(4);
    r.render(input(smaller, { slots: true }));
    expect(llLines()).toHaveLength(4);
    expect(r.nodeFor(4)).toBeUndefined();
    expect(r.nodeFor(5)).toBeUndefined();
    expect(r.nodeFor(3)).toBeDefined();
  });

  it('starts over when the song changes (different path)', () => {
    const r = new LineRenderer();
    const a = readPage(document, { pathname: '/a-lyrics', href: 'http://localhost/a-lyrics' } as Location)!;
    r.render(input(a, { slots: true }));
    const before = r.nodeFor(0)!;

    const b = readPage(document, { pathname: '/b-lyrics', href: 'http://localhost/b-lyrics' } as Location)!;
    expect(b.path).not.toBe(a.path);
    r.render(input(b, { slots: true }));
    expect(before.isConnected).toBe(false);
    expect(r.nodeFor(0)).not.toBe(before);
    expect(llLines()).toHaveLength(6);
  });
});

describe('clear', () => {
  it('removes every node and forgets them', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    r.clear();
    expect(llLines()).toHaveLength(0);
    expect(r.nodeFor(0)).toBeUndefined();
    expect(r.damaged()).toBe(false);
  });

  it('also sweeps nodes it does not own', () => {
    const stray = document.createElement('span');
    stray.className = 'll-line';
    page.containers[0]!.appendChild(stray);
    new LineRenderer().clear();
    expect(stray.isConnected).toBe(false);
  });

  it('can render again afterwards', () => {
    const r = new LineRenderer();
    r.render(input(page, { slots: true }));
    r.clear();
    r.render(input(page, { slots: true }));
    expect(llLines()).toHaveLength(6);
  });
});
