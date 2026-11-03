import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyStatus, markKey, modelsFor } from '../src/llm/chain';
import { LLMError } from '../src/llm/errors';
import { memoryStorage, setJSON, setKV } from '../src/platform/storage';
import { currentSettings, loadSettings, setApiKey } from '../src/store/settings';
import type { SongRecord } from '../src/core/types';
import { exportSongs, loadSong, saveSong, storageSummary } from '../src/store/songs';
import { closeSheet, modelLabel, openSheet } from '../src/ui/sheet';
import { formatWhen } from '../src/ui/time';

vi.mock('../src/llm/chain', () => ({
  modelsFor: vi.fn(),
  keyStatus: vi.fn(),
  markKey: vi.fn(),
}));

const modelsForMock = vi.mocked(modelsFor);
const keyStatusMock = vi.mocked(keyStatus);
const markKeyMock = vi.mocked(markKey);

const GEMINI_KEY = 'AIzaSyExampleGeminiKey1234';

/* ---------- helpers ---------- */

const host = (): HTMLElement | null => document.querySelector<HTMLElement>('.ll-sheet-host');
const shadow = (): ShadowRoot => host()!.shadowRoot!;
const text = (): string => shadow().textContent ?? '';

function buttonNamed(label: string): HTMLButtonElement {
  const found = Array.from(shadow().querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}" in: ${text()}`);
  return found;
}

function hasButton(label: string): boolean {
  return Array.from(shadow().querySelectorAll('button')).some((b) => b.textContent?.trim() === label);
}

function rowFor(id: string): HTMLElement {
  return shadow().querySelector<HTMLElement>(`[data-service="${id}"]`)!;
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** jsdom has no matchMedia: answer the two queries the sheet asks. */
function stubMatchMedia(answers: { desktop: boolean; dark: boolean }): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-color-scheme') ? answers.dark : query.includes('min-width') ? answers.desktop : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

async function ready(): Promise<void> {
  await vi.waitFor(() => expect(host()).not.toBeNull());
}

async function settingsReady(): Promise<void> {
  await ready();
  await vi.waitFor(() => expect(shadow().querySelectorAll('[data-service]').length).toBe(1));
  // statuses of rows that have a key resolve a moment later
  await vi.waitFor(() => expect(shadow().querySelector('.dot[data-s="pending"]')).toBeNull());
}

beforeEach(async () => {
  setKV(memoryStorage());
  await loadSettings();
  vi.resetAllMocks();
  modelsForMock.mockResolvedValue([{ id: 'gemini-test', label: 'Test', rank: 1 }]);
  markKeyMock.mockResolvedValue(undefined);
  keyStatusMock.mockImplementation(async (apiKey: string) => (apiKey ? { kind: 'ok' } : { kind: 'missing' }));
});

afterEach(() => {
  closeSheet();
  delete (window as { matchMedia?: unknown }).matchMedia;
  document.body.innerHTML = '';
  document.documentElement.classList.remove('ll-dark');
});

/* ---------- host ---------- */

describe('host', () => {
  it('appends one shadow-DOM host to the body and keeps all markup inside it', async () => {
    openSheet({ mode: 'first-run' });
    const hosts = document.querySelectorAll('.ll-sheet-host');
    expect(hosts.length).toBe(1);
    expect(hosts[0]!.parentElement).toBe(document.body);
    expect(hosts[0]!.shadowRoot).not.toBeNull();
    expect(hosts[0]!.children.length).toBe(0); // light DOM stays empty
    expect(shadow().querySelector('style')).not.toBeNull();
    expect(shadow().querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('shows only one sheet at a time and tells the first one it closed', () => {
    const first = vi.fn();
    openSheet({ mode: 'first-run', onClose: first });
    openSheet({ mode: 'settings' });
    expect(document.querySelectorAll('.ll-sheet-host').length).toBe(1);
    expect(first).toHaveBeenCalledWith(false);
  });

  it('keeps click, pointerdown and keydown away from the page', () => {
    openSheet({ mode: 'first-run' });
    const seen = vi.fn();
    for (const type of ['click', 'pointerdown', 'keydown']) document.addEventListener(type, seen);
    const input = shadow().querySelector('input')!;
    input.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));
    expect(seen).not.toHaveBeenCalled();
    for (const type of ['click', 'pointerdown', 'keydown']) document.removeEventListener(type, seen);
  });

  it('is fixed to the viewport so the page cannot move it', () => {
    openSheet({ mode: 'first-run' });
    expect(host()!.style.position).toBe('fixed');
    expect(host()!.getAttribute('lang')).toBe('ja');
  });

  it('is a bottom sheet with a backdrop on a phone, and does not raise the keyboard in settings', async () => {
    stubMatchMedia({ desktop: false, dark: false });
    openSheet({ mode: 'settings' });
    await settingsReady();
    const root = shadow().querySelector('.root')!;
    expect(root.getAttribute('data-layout')).toBe('phone');
    expect(root.getAttribute('data-place')).toBeNull();
    expect(shadow().activeElement).toBe(buttonNamed('閉じる'));
    closeSheet();

    openSheet({ mode: 'first-run' }); // first run always goes to the key field
    expect(shadow().activeElement).toBe(shadow().querySelector('input'));
  });

  it('settings goes to the key field on a desktop when no key is saved', async () => {
    openSheet({ mode: 'settings' });
    await settingsReady();
    expect(shadow().activeElement).toBe(rowFor('gemini').querySelector('input'));
  });

  it('follows the system dark scheme unless the page says otherwise', () => {
    stubMatchMedia({ desktop: true, dark: true });
    openSheet({ mode: 'first-run' });
    expect(shadow().querySelector('.root')!.getAttribute('data-theme')).toBe('dark');
    closeSheet();
    stubMatchMedia({ desktop: true, dark: false });
    openSheet({ mode: 'first-run' });
    expect(shadow().querySelector('.root')!.getAttribute('data-theme')).toBe('light');
  });

  it('follows the page-detected dark theme', () => {
    document.documentElement.classList.add('ll-dark');
    openSheet({ mode: 'first-run' });
    expect(shadow().querySelector('.root')!.getAttribute('data-theme')).toBe('dark');
  });

  it('places the panel under the anchor and flips upward when there is no room below', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const rect = (top: number): DOMRect => ({ top, bottom: top + 30, left: 700, right: 760, width: 60, height: 30, x: 700, y: top, toJSON: () => ({}) });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    anchor.getBoundingClientRect = () => rect(100);
    openSheet({ mode: 'first-run', anchor });
    let panel = shadow().querySelector<HTMLElement>('.panel')!;
    expect(shadow().querySelector('.root')!.getAttribute('data-place')).toBe('anchor');
    expect(panel.style.top).toBe('138px'); // bottom 130 + 8
    expect(panel.style.left).toBe('400px'); // right edge aligned: 760 - 360
    closeSheet();

    anchor.getBoundingClientRect = () => rect(780);
    openSheet({ mode: 'first-run', anchor });
    panel = shadow().querySelector<HTMLElement>('.panel')!;
    expect(panel.style.top).toBe('auto');
    expect(panel.style.bottom).toBe('28px'); // 800 - 780 + 8
  });

  it('hangs from the button’s right edge (設定 is the rightmost link), kept inside the window', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    const at = (left: number, right: number): void => {
      anchor.getBoundingClientRect = () => ({ top: 100, bottom: 130, left, right, width: right - left, height: 30, x: left, y: 100, toJSON: () => ({}) });
    };
    const leftOf = (): string => {
      openSheet({ mode: 'first-run', anchor });
      const left = shadow().querySelector<HTMLElement>('.panel')!.style.left;
      closeSheet();
      return left;
    };

    // Room on both sides: the panel's right edge meets the button's (the left edge no longer decides).
    at(540, 600);
    expect(leftOf()).toBe('240px'); // 600 - 360
    // Near the right of the window: the same rule, still inside it.
    at(940, 1000);
    expect(leftOf()).toBe('640px'); // 1000 - 360
    // Past what the window can hold: clamped to the right margin (1024 - 360 - 8).
    at(980, 1040);
    expect(leftOf()).toBe('656px');
    // A button near the left edge: clamped to the left margin.
    at(20, 80);
    expect(leftOf()).toBe('8px');
  });

  it('centres on desktop without an anchor', () => {
    openSheet({ mode: 'first-run' });
    expect(shadow().querySelector('.root')!.getAttribute('data-layout')).toBe('desktop');
    expect(shadow().querySelector('.root')!.getAttribute('data-place')).toBe('center');
  });
});

/* ---------- closing and focus ---------- */

describe('closing', () => {
  it('Escape closes with onClose(false)', async () => {
    const onClose = vi.fn();
    openSheet({ mode: 'first-run', onClose });
    shadow().querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(host()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('Escape works from the page too', () => {
    const onClose = vi.fn();
    openSheet({ mode: 'first-run', onClose });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(host()).toBeNull();
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('closes from 閉じる and from a click on the backdrop', () => {
    const onClose = vi.fn();
    openSheet({ mode: 'first-run', onClose });
    buttonNamed('閉じる').click();
    expect(host()).toBeNull();

    openSheet({ mode: 'first-run', onClose });
    shadow().querySelector<HTMLElement>('.panel')!.click(); // inside: stays
    expect(host()).not.toBeNull();
    shadow().querySelector<HTMLElement>('.backdrop')!.click();
    expect(host()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus in and gives it back', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    openSheet({ mode: 'first-run' });
    expect(shadow().activeElement).toBe(shadow().querySelector('input'));
    closeSheet();
    expect(document.activeElement).toBe(opener);
  });
});

/* ---------- first run ---------- */

describe('first-run sheet', () => {
  it('has the copy from the design, a password field and a safe link', () => {
    openSheet({ mode: 'first-run' });
    const t = text();
    for (const line of [
      '日本語訳をはじめる',
      'Google AI Studioを開き、Googleアカウントでログインして無料のAPIキーを作ります',
      'キーをコピーして、下に貼り付けます',
      'キーはこのブラウザにだけ保存され、Google以外には送られません',
      '保存してこの曲を訳す',
      '保存だけする',
    ]) expect(t).toContain(line);
    const link = Array.from(shadow().querySelectorAll('a')).find((a) => a.textContent === 'Google AI Studioを開く')!;
    expect(link.getAttribute('href')).toBe('https://aistudio.google.com/app/apikey');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    const input = shadow().querySelector('input')!;
    expect(input.type).toBe('password');
    expect(input.getAttribute('placeholder')).toBe('ここに貼り付け');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.spellcheck).toBe(false);
  });

  it('saves a verified key, closes, and then starts the translation', async () => {
    const calls: string[] = [];
    const onClose = vi.fn((changed: boolean) => { calls.push(`close:${changed}`); });
    const onSaveAndTranslate = vi.fn(() => { calls.push('translate'); });
    openSheet({ mode: 'first-run', onClose, onSaveAndTranslate });

    type(shadow().querySelector('input')!, `  ${GEMINI_KEY}  `);
    buttonNamed('保存してこの曲を訳す').click();
    expect(text()).toContain('確かめています…');

    await vi.waitFor(() => expect(onSaveAndTranslate).toHaveBeenCalledTimes(1));
    expect(modelsForMock).toHaveBeenCalledTimes(1);
    expect(modelsForMock.mock.calls[0]![1]).toEqual({ refresh: true });
    expect(modelsForMock.mock.calls[0]![0]).toBe(GEMINI_KEY);
    expect(markKeyMock).toHaveBeenCalledWith(GEMINI_KEY, false);
    const stored = await loadSettings();
    expect(stored.apiKey).toBe(GEMINI_KEY);
    expect(currentSettings().apiKey).toBe(GEMINI_KEY);
    expect(host()).toBeNull();
    expect(calls).toEqual(['close:true', 'translate']);
  });

  it('保存だけする saves and closes without translating', async () => {
    const onClose = vi.fn();
    const onSaveAndTranslate = vi.fn();
    openSheet({ mode: 'first-run', onClose, onSaveAndTranslate });
    type(shadow().querySelector('input')!, GEMINI_KEY);
    buttonNamed('保存だけする').click();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(onSaveAndTranslate).not.toHaveBeenCalled();
    expect((await loadSettings()).apiKey).toBe(GEMINI_KEY);
  });

  it('an empty key just focuses the field and sends nothing', () => {
    openSheet({ mode: 'first-run' });
    const input = shadow().querySelector('input')!;
    (document.activeElement as HTMLElement | null)?.blur();
    buttonNamed('保存だけする').focus();
    type(input, '   ');
    buttonNamed('保存だけする').click();
    expect(modelsForMock).not.toHaveBeenCalled();
    expect(shadow().activeElement).toBe(input);
    expect(shadow().querySelector('.msg')!.textContent).toBe('キーを貼り付けてください');
    expect(buttonNamed('保存してこの曲を訳す').disabled).toBe(false);
  });

  it('a rejected key shows the bad-key copy, stays open and saves nothing', async () => {
    modelsForMock.mockRejectedValue(new LLMError('auth', 'API key not valid', { status: 400 }));
    const onClose = vi.fn();
    const onSaveAndTranslate = vi.fn();
    openSheet({ mode: 'first-run', onClose, onSaveAndTranslate });
    const input = shadow().querySelector('input')!;
    type(input, 'not-a-real-key');
    buttonNamed('保存してこの曲を訳す').click();

    await vi.waitFor(() => expect(text()).toContain('このキーは使えませんでした。コピーし直してください'));
    expect(host()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaveAndTranslate).not.toHaveBeenCalled();
    expect(markKeyMock).not.toHaveBeenCalled();
    expect((await loadSettings()).apiKey).toBe('');
    expect(input.value).toBe('not-a-real-key'); // kept for editing
    expect(input.disabled).toBe(false);
    expect(buttonNamed('保存してこの曲を訳す').disabled).toBe(false);

    type(input, 'not-a-real-key2'); // editing clears the complaint
    expect(text()).not.toContain('このキーは使えませんでした');
  });

  it('a connection problem shows the network copy and stays open', async () => {
    modelsForMock.mockRejectedValue(new LLMError('network', 'offline'));
    const onClose = vi.fn();
    openSheet({ mode: 'first-run', onClose });
    type(shadow().querySelector('input')!, GEMINI_KEY);
    buttonNamed('保存だけする').click();
    await vi.waitFor(() => expect(text()).toContain('Googleにつながりませんでした。接続を確認してください'));
    expect(host()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect((await loadSettings()).apiKey).toBe('');

    modelsForMock.mockRejectedValue(new LLMError('timeout', 'slow'));
    buttonNamed('保存だけする').click();
    await vi.waitFor(() => expect(modelsForMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(buttonNamed('保存だけする').disabled).toBe(false));
    expect(text()).toContain('Googleが混み合っていて、確かめられませんでした。少しおいてから、もう一度試してください');
    expect(text()).not.toContain('接続を確認してください');
  });

  it('a Google-side failure says Google is busy, not that the connection is bad, and saves nothing', async () => {
    const onClose = vi.fn();
    openSheet({ mode: 'first-run', onClose });
    const input = shadow().querySelector('input')!;
    const message = (): string => shadow().querySelector('.msg')!.textContent ?? '';
    const check = async (error: unknown, expected: string): Promise<void> => {
      modelsForMock.mockReset();
      modelsForMock.mockRejectedValue(error);
      buttonNamed('保存だけする').click();
      await vi.waitFor(() => expect(modelsForMock).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(buttonNamed('保存だけする').disabled).toBe(false));
      expect(message()).toBe(expected);
    };

    type(input, 'AIzaTESTKEY0000000000000000000');
    await check(new LLMError('overloaded', 'x', { status: 503 }), 'Googleが混み合っていて、確かめられませんでした。少しおいてから、もう一度試してください');
    expect(markKeyMock).not.toHaveBeenCalled();
    expect((await loadSettings()).apiKey).toBe('');
    expect(input.value).toBe('AIzaTESTKEY0000000000000000000');
    expect(onClose).not.toHaveBeenCalled();

    await check(new LLMError('rate', 'x', { status: 429 }), 'Googleが混み合っていて、確かめられませんでした。少しおいてから、もう一度試してください');
    await check(new Error('boom'), 'Googleが混み合っていて、確かめられませんでした。少しおいてから、もう一度試してください');
    await check(new LLMError('network', 'x'), 'Googleにつながりませんでした。接続を確認してください');
    await check(new LLMError('auth', 'x', { status: 400 }), 'このキーは使えませんでした。コピーし直してください');
    expect(input.value).toBe('AIzaTESTKEY0000000000000000000');
    expect((await loadSettings()).apiKey).toBe('');
  });

  it('does not save when the sheet is closed while the key is being checked', async () => {
    let release: (v: []) => void = () => {};
    modelsForMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const onSaveAndTranslate = vi.fn();
    openSheet({ mode: 'first-run', onSaveAndTranslate });
    type(shadow().querySelector('input')!, GEMINI_KEY);
    buttonNamed('保存してこの曲を訳す').click();
    closeSheet();
    release([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(onSaveAndTranslate).not.toHaveBeenCalled();
    expect((await loadSettings()).apiKey).toBe('');
  });
});

/* ---------- settings ---------- */

describe('settings sheet', () => {
  it('shows the one Gemini row with its status', async () => {
    const until = Date.now() + 3 * 3600_000;
    await setApiKey(GEMINI_KEY);
    keyStatusMock.mockImplementation(async () => ({ kind: 'resting', until }));

    openSheet({ mode: 'settings' });
    await settingsReady();

    expect(shadow().querySelector('.title')!.textContent).toBe('Lyric Lensの設定');
    expect(text()).toContain('翻訳に使うAI');
    expect(text()).not.toMatch(/Groq|OpenRouter|上から順に/);

    const rows = Array.from(shadow().querySelectorAll<HTMLElement>('[data-service]'));
    expect(rows.map((r) => r.dataset.service)).toEqual(['gemini']);
    expect(rows[0]!.querySelector('.service-name')!.textContent).toBe('Google Gemini');
    const when = formatWhen(until);
    const status = rows[0]!.querySelector<HTMLElement>('.status')!;
    expect(status.textContent).toBe(`今日の無料枠を使い切りました（${when}から使えます）`);
    expect(status.dataset.s).toBe('resting');

    // the saved key is masked, with キーを消す and no field
    expect(rowFor('gemini').querySelector('.mask')!.textContent).toBe('••••1234');
    expect(rowFor('gemini').textContent).toContain('キーを消す');
    expect(rowFor('gemini').querySelector('input')).toBeNull();
    expect(text()).not.toContain(GEMINI_KEY);
  });

  it('without a key the row offers a field, 保存 and キーを作る', async () => {
    openSheet({ mode: 'settings' });
    await settingsReady();
    expect(rowFor('gemini').querySelector('.status')!.textContent).toBe('未設定');
    expect(rowFor('gemini').querySelector('input')).not.toBeNull();
    expect(rowFor('gemini').textContent).toContain('保存');
    const make = rowFor('gemini').querySelector('a')!;
    expect(make.textContent).toBe('Google AI Studioでキーを作る');
    expect(make.getAttribute('href')).toBe('https://aistudio.google.com/app/apikey');
    expect(make.getAttribute('target')).toBe('_blank');
    expect(text()).not.toContain('キーを足す');
  });

  it('shows the bad-key status', async () => {
    await setApiKey(GEMINI_KEY);
    keyStatusMock.mockImplementation(async () => ({ kind: 'bad' }));
    openSheet({ mode: 'settings' });
    await settingsReady();
    expect(rowFor('gemini').querySelector('.status')!.textContent).toBe('キーが使えません');
  });

  it('キーを消す clears the stored key and brings back the field', async () => {
    await setApiKey(GEMINI_KEY);
    const onClose = vi.fn();
    openSheet({ mode: 'settings', onClose });
    await settingsReady();

    const remove = Array.from(rowFor('gemini').querySelectorAll('button')).find((b) => b.textContent === 'キーを消す')!;
    remove.click();
    await vi.waitFor(() => expect(rowFor('gemini').querySelector('input')).not.toBeNull());
    expect(rowFor('gemini').querySelector('.status')!.textContent).toBe('未設定');
    expect((await loadSettings()).apiKey).toBe('');

    buttonNamed('閉じる').click();
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('saves a verified key and shows it masked', async () => {
    openSheet({ mode: 'settings' });
    await settingsReady();
    type(rowFor('gemini').querySelector('input')!, GEMINI_KEY);
    Array.from(rowFor('gemini').querySelectorAll('button')).find((b) => b.textContent === '保存')!.click();
    expect(rowFor('gemini').querySelector('.status')!.textContent).toBe('確かめています…');

    await vi.waitFor(() => expect(rowFor('gemini').querySelector('.mask')).not.toBeNull());
    expect(rowFor('gemini').querySelector('.mask')!.textContent).toBe('••••1234');
    expect(rowFor('gemini').querySelector('.status')!.textContent).toBe('使えます');
    expect(markKeyMock).toHaveBeenCalledWith(GEMINI_KEY, false);
    expect((await loadSettings()).apiKey).toBe(GEMINI_KEY);
    expect(text()).not.toContain(GEMINI_KEY);
  });

  it('a rejected key marks the row and keeps the field; a network failure keeps it too', async () => {
    openSheet({ mode: 'settings' });
    await settingsReady();
    const input = rowFor('gemini').querySelector('input')!;
    const save = () => Array.from(rowFor('gemini').querySelectorAll('button')).find((b) => b.textContent === '保存')!.click();

    modelsForMock.mockRejectedValue(new LLMError('auth', 'bad', { status: 401 }));
    type(input, 'wrong-key');
    save();
    await vi.waitFor(() => expect(rowFor('gemini').querySelector('.status')!.textContent).toBe('キーが使えません'));
    expect(rowFor('gemini').querySelector('input')).toBe(input);
    expect(input.value).toBe('wrong-key');
    expect((await loadSettings()).apiKey).toBe('');

    modelsForMock.mockRejectedValue(new LLMError('network', 'offline'));
    save();
    await vi.waitFor(() => expect(rowFor('gemini').textContent).toContain('Googleにつながりませんでした。接続を確認してください'));
    expect(rowFor('gemini').querySelector('input')).toBe(input);
    expect((await loadSettings()).apiKey).toBe('');
  });

  it('a Google-side failure (503) shows the busy message in the row, keeps the field and saves nothing', async () => {
    openSheet({ mode: 'settings' });
    await settingsReady();
    const input = rowFor('gemini').querySelector('input')!;
    modelsForMock.mockRejectedValue(new LLMError('overloaded', 'x', { status: 503 }));
    type(input, 'AIzaTESTKEY0000000000000000000');
    Array.from(rowFor('gemini').querySelectorAll('button')).find((b) => b.textContent === '保存')!.click();
    await vi.waitFor(() => expect(rowFor('gemini').querySelector('.msg')!.textContent).toBe('Googleが混み合っていて、確かめられませんでした。少しおいてから、もう一度試してください'));
    expect(rowFor('gemini').textContent).not.toContain('接続を確認してください');
    expect(rowFor('gemini').querySelector('input')).toBe(input);
    expect(input.value).toBe('AIzaTESTKEY0000000000000000000');
    expect((await loadSettings()).apiKey).toBe('');
  });

  it('has no 「この曲」 section without a song', async () => {
    openSheet({ mode: 'settings' });
    await settingsReady();
    expect(text()).not.toContain('この曲を訳し直す');
    expect(text()).toContain('保存データ');
  });

  it('shows the last error of this song in a collapsed disclosure, only when there is one', async () => {
    openSheet({ mode: 'settings', song: { title: 'x', lastError: { kind: 'bad-request', model: 'gemini-3.5-flash', status: 400, text: 'invalid field' } } });
    await settingsReady();
    const details = shadow().querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector('summary')!.textContent).toBe('直近のエラー');
    expect(details!.textContent).toContain('Gemini 3.5 Flash · 400 · bad-request');
    expect(details!.textContent).toContain('invalid field');
  });

  it('shows only the error when a first request failed before any line (no edition yet)', async () => {
    openSheet({ mode: 'settings', song: { title: 'x', edition: false, lastError: { kind: 'unusable', model: 'gemini-3.6-flash', status: 200, text: 'not JSONL' } } });
    await settingsReady();
    expect(text()).toContain('この曲');
    expect(shadow().querySelector('details summary')!.textContent).toBe('直近のエラー');
    expect(text()).not.toContain('訳しました');
    expect(text()).not.toContain('この曲を訳し直す');
    expect(text()).not.toContain('この曲の訳を消す');
  });

  it('has no error disclosure without a stored error', async () => {
    openSheet({ mode: 'settings', song: { title: 'x', model: 'gemma-4' } });
    await settingsReady();
    expect(shadow().querySelector('details')).toBeNull();
  });

  it('describes this song and asks before retranslating', async () => {
    const onRetranslate = vi.fn();
    const onClose = vi.fn();
    const translatedAt = Date.UTC(2026, 2, 5, 3, 0, 0);
    openSheet({ mode: 'settings', song: { title: 'HUMBLE.', model: 'gemini-3.5-flash', translatedAt }, onRetranslate, onClose });
    await settingsReady();

    // The model reads as a name, not as an id.
    expect(text()).toContain('2026年3月5日にGemini 3.5 Flashで訳しました');
    expect(text()).not.toContain('gemini-3.5-flash');

    buttonNamed('この曲を訳し直す').click();
    expect(text()).toContain('今の訳を残したまま訳し直し、訳し終えたら新しい訳に入れ替えます');
    expect(hasButton('この曲を訳し直す')).toBe(false); // the confirm replaced the button row in place
    expect(onRetranslate).not.toHaveBeenCalled();

    buttonNamed('やめる').click();
    expect(hasButton('この曲を訳し直す')).toBe(true);
    expect(text()).not.toContain('無料枠を1回使います');
    expect(onRetranslate).not.toHaveBeenCalled();

    buttonNamed('この曲を訳し直す').click();
    buttonNamed('訳し直す').click();
    expect(host()).toBeNull();
    expect(onRetranslate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('omits the unknown part of the song line', async () => {
    openSheet({ mode: 'settings', song: { title: 'x', model: 'gemma-4' } });
    await settingsReady();
    expect(text()).toContain('Gemma 4で訳しました');
    expect(text()).not.toContain('に訳しました');
    closeSheet();

    openSheet({ mode: 'settings', song: { title: 'x', translatedAt: Date.UTC(2026, 11, 31, 3) } });
    await settingsReady();
    expect(text()).toContain('2026年12月31日に訳しました');
    closeSheet();

    openSheet({ mode: 'settings', song: { title: 'x' } });
    await settingsReady();
    expect(text()).not.toContain('訳しました');
  });

  it('deletes this song only after confirming, then closes as changed', async () => {
    const onDeleteSong = vi.fn(async () => {});
    const onClose = vi.fn();
    openSheet({ mode: 'settings', song: { title: 'x', model: 'm' }, onDeleteSong, onClose });
    await settingsReady();

    buttonNamed('この曲の訳を消す').click();
    expect(text()).toContain('この曲の保存した訳を消します。元に戻せません');
    expect(onDeleteSong).not.toHaveBeenCalled();
    buttonNamed('消す').click();
    await vi.waitFor(() => expect(host()).toBeNull());
    expect(onDeleteSong).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('shows the saved-data summary and clears everything after confirming', async () => {
    await setJSON('ll3:s:1', { v: 2, pad: 'x'.repeat(2000) });
    await setJSON('ll3:s:2', { v: 2, pad: 'y'.repeat(2000) });
    const before = await storageSummary();
    expect(before.count).toBe(2);

    const onClose = vi.fn();
    openSheet({ mode: 'settings', onClose });
    await settingsReady();
    await vi.waitFor(() => expect(text()).toMatch(/2曲を保存しています（\d+ KB）/));

    buttonNamed('すべて消す').click();
    expect(shadow().querySelector('[data-danger]')).toBeNull();
    expect(buttonNamed('すべて消す').dataset.v).toBe('solid'); // the confirm button
    expect(text()).toContain('保存した2曲の訳をすべて消します。元に戻せません');
    expect((await storageSummary()).count).toBe(2); // nothing yet
    buttonNamed('すべて消す').click();

    await vi.waitFor(() => expect(text()).toContain('保存した曲はありません'));
    expect((await storageSummary()).count).toBe(0);
    expect(host()).not.toBeNull(); // the sheet stays open
    expect(buttonNamed('すべて消す').disabled).toBe(true);

    buttonNamed('閉じる').click();
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('keeps clicks inside the sheet, with no window.confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    openSheet({ mode: 'settings', song: { title: 'x', model: 'm' } });
    await settingsReady();
    buttonNamed('この曲の訳を消す').click();
    buttonNamed('やめる').click();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

/* ---------- a rejected key ---------- */

describe('a rejected key', () => {
  async function badKey(): Promise<void> {
    await setApiKey(GEMINI_KEY);
    keyStatusMock.mockImplementation(async () => ({ kind: 'bad' }));
  }

  it('offers キーを入れ直す instead of キーを消す', async () => {
    await badKey();
    openSheet({ mode: 'settings' });
    await settingsReady();
    const labels = Array.from(rowFor('gemini').querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels).toEqual(['キーを入れ直す']);
  });

  it('removing it puts the cursor in the new field, even on a phone', async () => {
    stubMatchMedia({ desktop: false, dark: false });
    await badKey();
    openSheet({ mode: 'settings' });
    await settingsReady();
    buttonNamed('キーを入れ直す').click();
    await vi.waitFor(() => expect(rowFor('gemini').querySelector('input')).not.toBeNull());
    expect(shadow().activeElement).toBe(rowFor('gemini').querySelector('input'));
    expect((await loadSettings()).apiKey).toBe('');
    expect(rowFor('gemini').querySelector('.status')!.textContent).toBe('未設定');
  });

  it('a working key removed on a phone still leaves the keyboard down (focus goes to the row)', async () => {
    stubMatchMedia({ desktop: false, dark: false });
    await setApiKey(GEMINI_KEY);
    openSheet({ mode: 'settings' });
    await settingsReady();
    buttonNamed('キーを消す').click();
    await vi.waitFor(() => expect(rowFor('gemini').querySelector('input')).not.toBeNull());
    expect(shadow().activeElement).toBe(rowFor('gemini'));
  });
});

/* ---------- saved data: 書き出す / 読み込む ---------- */

describe('saved data export and import', () => {
  const NOT_AN_EXPORT = '読み込めませんでした。Lyric Lensで書き出したファイルを選んでください';

  function song(id: string, lines = 2): SongRecord {
    const map: SongRecord['lines'] = {};
    for (let i = 0; i < lines; i++) map[`line ${id} ${i}`] = { ja: `訳 ${i}`, notes: [{ kind: 'slang', phrase: 'x', text: '説明' }] };
    return { v: 2, id, path: `/${id}`, title: `Song ${id}`, artist: 'A', lines: map, model: 'm', createdAt: 1, updatedAt: 1 };
  }

  const fileInput = (): HTMLInputElement => shadow().querySelector<HTMLInputElement>('input[type="file"]')!;
  const dataMessage = (): HTMLElement => {
    const section = Array.from(shadow().querySelectorAll<HTMLElement>('.section')).find((s) => s.querySelector('.section-title')?.textContent === '保存データ')!;
    return section.querySelector<HTMLElement>('.msg')!;
  };

  /** Hands the sheet a file the way the browser's picker does. */
  function choose(input: HTMLInputElement, content: string): void {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([content], 'lyric-lens.json', { type: 'application/json' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function readBlob(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  }

  let created: Blob[] = [];
  let clicked: HTMLAnchorElement[] = [];
  let anchorClick: { mockRestore(): void };

  beforeEach(() => {
    created = [];
    clicked = [];
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn((blob: Blob) => { created.push(blob); return 'blob:lyric-lens-test'; }) });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this); });
  });

  afterEach(() => {
    anchorClick.mockRestore();
    delete (URL as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it('reads top to bottom: the status line, the actions, the explanation, then the message line', async () => {
    await saveSong(song('1'));
    openSheet({ mode: 'settings' });
    await settingsReady();
    await vi.waitFor(() => expect(text()).toMatch(/1曲を保存しています（\d+ KB）/));
    const section = Array.from(shadow().querySelectorAll<HTMLElement>('.section')).find((s) => s.querySelector('.section-title')?.textContent === '保存データ')!;
    expect(Array.from(section.children).map((c) => c.className || c.tagName.toLowerCase())).toEqual(['section-title', 'line', 'zone', 'section-lead', 'msg', 'input']);
    const [, status, actions, lead, message] = Array.from(section.children);
    expect(status!.textContent).toMatch(/^1曲を保存しています（\d+ KB）$/);
    expect(Array.from(actions!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['書き出す', '読み込む', 'すべて消す']);
    expect(lead!.textContent).toBe('書き出したファイルは、別の端末でも読み込めます');
    expect(message!.textContent).toBe('');
  });

  it('shows 書き出す, 読み込む and すべて消す, with only 読み込む available when nothing is saved', async () => {
    openSheet({ mode: 'settings' });
    await settingsReady();
    await vi.waitFor(() => expect(text()).toContain('保存した曲はありません'));
    expect(text()).toContain('書き出したファイルは、別の端末でも読み込めます');
    expect(buttonNamed('書き出す').disabled).toBe(true);
    expect(buttonNamed('読み込む').disabled).toBe(false);
    expect(buttonNamed('すべて消す').disabled).toBe(true);
    const input = fileInput();
    expect(input.getAttribute('accept')).toBe('application/json');
    expect(input.hidden).toBe(true);
    expect(input.tabIndex).toBe(-1);
    expect(host()!.children.length).toBe(0); // still all inside the shadow root
  });

  it('書き出す downloads one JSON file with every saved song and says how many', async () => {
    await saveSong(song('1'));
    await saveSong({ ...song('2'), stop: { reason: 'length', at: 5 } });
    openSheet({ mode: 'settings' });
    await settingsReady();
    await vi.waitFor(() => expect(buttonNamed('書き出す').disabled).toBe(false));
    buttonNamed('書き出す').click();
    await vi.waitFor(() => expect(dataMessage().textContent).toBe('2曲を書き出しました'));

    expect(clicked.length).toBe(1);
    expect(clicked[0]!.getAttribute('download')).toMatch(/^lyric-lens-\d{8}\.json$/);
    expect(clicked[0]!.getAttribute('href')).toBe('blob:lyric-lens-test');
    expect(clicked[0]!.isConnected).toBe(false); // the link does not stay in the sheet
    expect(created.length).toBe(1);
    expect(created[0]!.type).toBe('application/json');
    const file = JSON.parse(await readBlob(created[0]!)) as { app: string; v: number; songs: SongRecord[] };
    expect(file.app).toBe('lyric-lens');
    expect(file.songs.map((s) => s.id).sort()).toEqual(['1', '2']);
    expect(file.songs.find((s) => s.id === '2')!.stop?.reason).toBe('length');
    expect(buttonNamed('書き出す').disabled).toBe(false); // ready again
  });

  it('says so when the file could not be made', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    (URL.createObjectURL as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('no blobs'); });
    await saveSong(song('1'));
    openSheet({ mode: 'settings' });
    await settingsReady();
    await vi.waitFor(() => expect(buttonNamed('書き出す').disabled).toBe(false));
    buttonNamed('書き出す').click();
    await vi.waitFor(() => expect(dataMessage().textContent).toBe('書き出せませんでした'));
    expect(dataMessage().dataset.kind).toBe('error');
    error.mockRestore();
  });

  it('読み込む opens the hidden file picker', async () => {
    openSheet({ mode: 'settings' });
    await settingsReady();
    const picker = vi.spyOn(fileInput(), 'click').mockImplementation(() => {});
    buttonNamed('読み込む').click();
    expect(picker).toHaveBeenCalledTimes(1);
  });

  it('imports an exported file, updates the count and closes as changed', async () => {
    await saveSong(song('1'));
    await saveSong({ ...song('2'), stop: { reason: 'busy', at: 5 } });
    const exported = await exportSongs();
    setKV(memoryStorage()); // another device
    await loadSettings();

    const onClose = vi.fn();
    openSheet({ mode: 'settings', onClose });
    await settingsReady();
    await vi.waitFor(() => expect(text()).toContain('保存した曲はありません'));
    choose(fileInput(), exported);
    await vi.waitFor(() => expect(dataMessage().textContent).toBe('2曲を読み込みました'));
    expect(dataMessage().dataset.kind).toBeUndefined();
    expect(text()).toContain('2曲を保存しています');
    expect((await loadSong('1'))!.title).toBe('Song 1');
    expect((await loadSong('2'))!.stop?.reason).toBe('busy');
    expect(buttonNamed('書き出す').disabled).toBe(false);
    expect(buttonNamed('すべて消す').disabled).toBe(false);
    buttonNamed('閉じる').click();
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('refuses a file that is not a Lyric Lens export and changes nothing', async () => {
    await saveSong(song('1'));
    const onClose = vi.fn();
    openSheet({ mode: 'settings', onClose });
    await settingsReady();
    await vi.waitFor(() => expect(text()).toContain('1曲を保存しています'));

    choose(fileInput(), '{"hello":"world"}');
    await vi.waitFor(() => expect(dataMessage().textContent).toBe(NOT_AN_EXPORT));
    expect(dataMessage().dataset.kind).toBe('error');

    choose(fileInput(), 'this is not json');
    await vi.waitFor(() => expect(buttonNamed('読み込む').disabled).toBe(false));
    expect(dataMessage().textContent).toBe(NOT_AN_EXPORT);
    expect((await storageSummary()).count).toBe(1);
    expect(host()).not.toBeNull(); // the sheet stays open
    buttonNamed('閉じる').click();
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('says when a valid file brings nothing new', async () => {
    await saveSong(song('1'));
    const exported = await exportSongs();
    const onClose = vi.fn();
    openSheet({ mode: 'settings', onClose });
    await settingsReady();
    await vi.waitFor(() => expect(text()).toContain('1曲を保存しています'));
    choose(fileInput(), exported);
    await vi.waitFor(() => expect(dataMessage().textContent).toBe('新しく読み込める曲はありませんでした'));
    buttonNamed('閉じる').click();
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('leaves the song a request is writing alone', async () => {
    await saveSong(song('1'));
    await saveSong(song('2'));
    const exported = await exportSongs();
    setKV(memoryStorage());
    await loadSettings();

    openSheet({ mode: 'settings', busySongId: '2' });
    await settingsReady();
    choose(fileInput(), exported);
    await vi.waitFor(() => expect(dataMessage().textContent).toBe('1曲を読み込みました'));
    expect(await loadSong('1')).not.toBeNull();
    expect(await loadSong('2')).toBeNull();
  });

  it('keeps Tab inside the sheet: the hidden file input does not count as the last stop', async () => {
    await saveSong(song('1'));
    openSheet({ mode: 'settings' });
    await settingsReady();
    await vi.waitFor(() => expect(buttonNamed('すべて消す').disabled).toBe(false));
    const last = buttonNamed('すべて消す');
    last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, composed: true });
    last.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(shadow().activeElement).toBe(buttonNamed('閉じる'));
  });

  it('still clears everything after confirming, and the buttons come back', async () => {
    await saveSong(song('1'));
    openSheet({ mode: 'settings' });
    await settingsReady();
    await vi.waitFor(() => expect(buttonNamed('すべて消す').disabled).toBe(false));
    buttonNamed('すべて消す').click();
    expect(hasButton('書き出す')).toBe(false); // the confirm replaced the row
    buttonNamed('すべて消す').click();
    await vi.waitFor(() => expect(text()).toContain('保存した曲はありません'));
    expect(hasButton('書き出す')).toBe(true);
    expect(hasButton('読み込む')).toBe(true);
    expect(buttonNamed('書き出す').disabled).toBe(true);
    expect(buttonNamed('読み込む').disabled).toBe(false);
  });
});

/* ---------- model names ---------- */

describe('modelLabel', () => {
  it('turns a model id into the name a reader says', () => {
    expect(modelLabel('gemini-3.8-flash')).toBe('Gemini 3.8 Flash');
    expect(modelLabel('gemini-3-flash-preview')).toBe('Gemini 3 Flash Preview');
    expect(modelLabel('gemini-3.5-flash-lite')).toBe('Gemini 3.5 Flash-Lite');
    expect(modelLabel('gemma-4-31b-it')).toBe('Gemma 4 31B');
  });

  it('reads the other ids of the same kind the same way', () => {
    expect(modelLabel('gemini-2.5-flash')).toBe('Gemini 2.5 Flash');
    expect(modelLabel('gemini-3.1-flash-lite')).toBe('Gemini 3.1 Flash-Lite');
    expect(modelLabel('gemini-2.5-pro')).toBe('Gemini 2.5 Pro');
    expect(modelLabel('gemma-3-27b-it')).toBe('Gemma 3 27B');
    expect(modelLabel('gemma-4')).toBe('Gemma 4');
  });

  it('leaves an id it does not know exactly as it is', () => {
    for (const id of ['', 'm', 'gemini-test', 'gemini-flash-latest', 'gemma-3n-e4b-it', 'Gemini-3-Flash', 'gpt-4o', 'models/gemini-3-flash']) {
      expect(modelLabel(id)).toBe(id);
    }
  });
});
