import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProvider, keyStatus, markKey, modelsFor } from '../src/llm/chain';
import { LLMError } from '../src/llm/errors';
import type { ProviderConfig } from '../src/llm/types';
import { memoryStorage, setJSON, setKV } from '../src/platform/storage';
import { currentSettings, loadSettings, setProviderKey } from '../src/store/settings';
import { storageSummary } from '../src/store/songs';
import { closeSheet, openSheet } from '../src/ui/sheet';
import { formatWhen } from '../src/ui/time';

vi.mock('../src/llm/chain', () => ({
  createProvider: vi.fn(),
  modelsFor: vi.fn(),
  keyStatus: vi.fn(),
  markKey: vi.fn(),
}));

const createProviderMock = vi.mocked(createProvider);
const modelsForMock = vi.mocked(modelsFor);
const keyStatusMock = vi.mocked(keyStatus);
const markKeyMock = vi.mocked(markKey);

const GEMINI_KEY = 'AIzaSyExampleGeminiKey1234';
const GROQ_KEY = 'gsk_exampleGroqKey_wxyz';

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
  await vi.waitFor(() => expect(shadow().querySelectorAll('[data-service]').length).toBe(3));
  // statuses of rows that have a key resolve a moment later
  await vi.waitFor(() => expect(shadow().querySelector('.dot[data-s="pending"]')).toBeNull());
}

beforeEach(async () => {
  setKV(memoryStorage());
  await loadSettings();
  vi.resetAllMocks();
  createProviderMock.mockImplementation((config: ProviderConfig) => ({ config, listModels: vi.fn(), generate: vi.fn() }));
  modelsForMock.mockResolvedValue([{ id: 'gemini-test', label: 'Test', rank: 1 }]);
  markKeyMock.mockResolvedValue(undefined);
  keyStatusMock.mockImplementation(async (config: ProviderConfig) => (config.apiKey ? { kind: 'ok' } : { kind: 'missing' }));
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

  it('settings goes to the first empty key field on a desktop', async () => {
    await setProviderKey('gemini', GEMINI_KEY);
    openSheet({ mode: 'settings' });
    await settingsReady();
    expect(shadow().activeElement).toBe(rowFor('groq').querySelector('input'));
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
    expect(panel.style.left).toBe('360px'); // right edge aligned: 760 - 400
    closeSheet();

    anchor.getBoundingClientRect = () => rect(780);
    openSheet({ mode: 'first-run', anchor });
    panel = shadow().querySelector<HTMLElement>('.panel')!;
    expect(panel.style.top).toBe('auto');
    expect(panel.style.bottom).toBe('28px'); // 800 - 780 + 8
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
      'Google AI Studio を開いて、無料のAPIキーを作ります',
      'キーをコピーして、下に貼り付けます',
      'キーはこの端末のスクリプト用保存領域にだけ保存されます',
      '保存してこの曲を訳す',
      '保存だけする',
    ]) expect(t).toContain(line);
    const link = Array.from(shadow().querySelectorAll('a')).find((a) => a.textContent === 'Google AI Studio を開く')!;
    expect(link.getAttribute('href')).toBe('https://aistudio.google.com/app/apikey');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    const input = shadow().querySelector('input')!;
    expect(input.type).toBe('password');
    expect(input.getAttribute('placeholder')).toBe('APIキーを貼り付け');
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
    expect(createProviderMock.mock.calls[0]![0]).toMatchObject({ preset: 'gemini', apiKey: GEMINI_KEY });
    expect(markKeyMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: GEMINI_KEY }), false);
    const stored = await loadSettings();
    expect(stored.providers.find((p) => p.preset === 'gemini')!.apiKey).toBe(GEMINI_KEY);
    expect(currentSettings().providers[0]!.apiKey).toBe(GEMINI_KEY);
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
    expect((await loadSettings()).providers[0]!.apiKey).toBe(GEMINI_KEY);
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
    expect((await loadSettings()).providers[0]!.apiKey).toBe('');
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
    await vi.waitFor(() => expect(text()).toContain('確かめられませんでした。接続を確認してください'));
    expect(host()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect((await loadSettings()).providers[0]!.apiKey).toBe('');

    modelsForMock.mockRejectedValue(new LLMError('timeout', 'slow'));
    buttonNamed('保存だけする').click();
    await vi.waitFor(() => expect(modelsForMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(buttonNamed('保存だけする').disabled).toBe(false));
    expect(text()).toContain('確かめられませんでした。接続を確認してください');
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
    expect((await loadSettings()).providers[0]!.apiKey).toBe('');
  });
});

/* ---------- settings ---------- */

describe('settings sheet', () => {
  it('lists the three services in order with their status', async () => {
    const until = Date.now() + 3 * 3600_000;
    await setProviderKey('gemini', GEMINI_KEY);
    await setProviderKey('openrouter', 'sk-or-v1-abcdef123456');
    keyStatusMock.mockImplementation(async (config: ProviderConfig) => {
      if (config.preset === 'gemini') return { kind: 'ok' };
      if (config.preset === 'openrouter') return { kind: 'resting', until };
      return { kind: 'missing' };
    });

    openSheet({ mode: 'settings' });
    await settingsReady();

    expect(shadow().querySelector('.title')!.textContent).toBe('Lyric Lens の設定');
    expect(text()).toContain('翻訳に使うサービス');
    expect(text()).toContain('上から順に使い、混雑や上限のときは自動で次に切り替えます');

    const rows = Array.from(shadow().querySelectorAll<HTMLElement>('[data-service]'));
    expect(rows.map((r) => r.dataset.service)).toEqual(['gemini', 'groq', 'openrouter']);
    expect(rows.map((r) => r.querySelector('.service-name')!.textContent)).toEqual([
      'Google AI Studio（Gemini）', 'Groq', 'OpenRouter（無料モデル）',
    ]);
    expect(rows.map((r) => r.querySelector('.status')!.textContent)).toEqual([
      '使えます', '未設定', `今日は${formatWhen(until)}まで休み`,
    ]);

    // saved keys are masked; the empty service offers a field, 保存 and キーを作る
    expect(rowFor('gemini').querySelector('.mask')!.textContent).toBe('••••1234');
    expect(rowFor('gemini').textContent).toContain('キーを消す');
    expect(rowFor('gemini').querySelector('input')).toBeNull();
    expect(text()).not.toContain(GEMINI_KEY);
    expect(rowFor('groq').querySelector('input')).not.toBeNull();
    expect(rowFor('groq').textContent).toContain('保存');
    const make = rowFor('groq').querySelector('a')!;
    expect(make.textContent).toBe('キーを作る');
    expect(make.getAttribute('href')).toBe('https://console.groq.com/keys');
    expect(make.getAttribute('target')).toBe('_blank');
  });

  it('shows the bad-key status', async () => {
    await setProviderKey('groq', GROQ_KEY);
    keyStatusMock.mockImplementation(async (config: ProviderConfig) => (config.preset === 'groq' ? { kind: 'bad' } : { kind: 'missing' }));
    openSheet({ mode: 'settings' });
    await settingsReady();
    expect(rowFor('groq').querySelector('.status')!.textContent).toBe('キーが使えません');
  });

  it('キーを消す clears the stored key and brings back the field', async () => {
    await setProviderKey('gemini', GEMINI_KEY);
    const onClose = vi.fn();
    openSheet({ mode: 'settings', onClose });
    await settingsReady();

    const remove = Array.from(rowFor('gemini').querySelectorAll('button')).find((b) => b.textContent === 'キーを消す')!;
    remove.click();
    await vi.waitFor(() => expect(rowFor('gemini').querySelector('input')).not.toBeNull());
    expect(rowFor('gemini').querySelector('.status')!.textContent).toBe('未設定');
    expect((await loadSettings()).providers.find((p) => p.preset === 'gemini')!.apiKey).toBe('');

    buttonNamed('閉じる').click();
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('saves a verified key for a service and shows it masked', async () => {
    openSheet({ mode: 'settings' });
    await settingsReady();
    type(rowFor('groq').querySelector('input')!, GROQ_KEY);
    Array.from(rowFor('groq').querySelectorAll('button')).find((b) => b.textContent === '保存')!.click();
    expect(rowFor('groq').querySelector('.status')!.textContent).toBe('確かめています…');

    await vi.waitFor(() => expect(rowFor('groq').querySelector('.mask')).not.toBeNull());
    expect(rowFor('groq').querySelector('.mask')!.textContent).toBe('••••wxyz');
    expect(rowFor('groq').querySelector('.status')!.textContent).toBe('使えます');
    expect(markKeyMock).toHaveBeenCalledWith(expect.objectContaining({ preset: 'groq', apiKey: GROQ_KEY }), false);
    expect((await loadSettings()).providers.find((p) => p.preset === 'groq')!.apiKey).toBe(GROQ_KEY);
    expect(text()).not.toContain(GROQ_KEY);
  });

  it('a rejected key marks the row and keeps the field; a network failure keeps it too', async () => {
    openSheet({ mode: 'settings' });
    await settingsReady();
    const input = rowFor('groq').querySelector('input')!;
    const save = () => Array.from(rowFor('groq').querySelectorAll('button')).find((b) => b.textContent === '保存')!.click();

    modelsForMock.mockRejectedValue(new LLMError('auth', 'bad', { status: 401 }));
    type(input, 'wrong-key');
    save();
    await vi.waitFor(() => expect(rowFor('groq').querySelector('.status')!.textContent).toBe('キーが使えません'));
    expect(rowFor('groq').querySelector('input')).toBe(input);
    expect(input.value).toBe('wrong-key');
    expect((await loadSettings()).providers.find((p) => p.preset === 'groq')!.apiKey).toBe('');

    modelsForMock.mockRejectedValue(new LLMError('network', 'offline'));
    save();
    await vi.waitFor(() => expect(rowFor('groq').textContent).toContain('確かめられませんでした。接続を確認してください'));
    expect(rowFor('groq').querySelector('input')).toBe(input);
    expect((await loadSettings()).providers.find((p) => p.preset === 'groq')!.apiKey).toBe('');
  });

  it('has no 「この曲」 section without a song', async () => {
    openSheet({ mode: 'settings' });
    await settingsReady();
    expect(text()).not.toContain('この曲を訳し直す');
    expect(text()).toContain('保存データ');
  });

  it('describes this song and asks before retranslating', async () => {
    const onRetranslate = vi.fn();
    const onClose = vi.fn();
    const translatedAt = Date.UTC(2026, 2, 5, 3, 0, 0);
    openSheet({ mode: 'settings', song: { title: 'HUMBLE.', model: 'gemini-3.5-flash', translatedAt }, onRetranslate, onClose });
    await settingsReady();

    expect(text()).toContain('この曲の訳：gemini-3.5-flash · 2026年3月5日');

    buttonNamed('この曲を訳し直す').click();
    expect(text()).toContain('この曲を訳し直しますか？無料枠を1回使います。終わるまで今の訳はそのまま表示されます');
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
    expect(text()).toContain('この曲の訳：gemma-4');
    expect(text()).not.toContain('gemma-4 ·');
    closeSheet();

    openSheet({ mode: 'settings', song: { title: 'x', translatedAt: Date.UTC(2026, 11, 31, 3) } });
    await settingsReady();
    expect(text()).toContain('この曲の訳：2026年12月31日');
    closeSheet();

    openSheet({ mode: 'settings', song: { title: 'x' } });
    await settingsReady();
    expect(text()).not.toContain('この曲の訳');
  });

  it('deletes this song only after confirming, then closes as changed', async () => {
    const onDeleteSong = vi.fn(async () => {});
    const onClose = vi.fn();
    openSheet({ mode: 'settings', song: { title: 'x', model: 'm' }, onDeleteSong, onClose });
    await settingsReady();

    buttonNamed('この曲の保存データを消す').click();
    expect(text()).toContain('この曲の保存した訳を消しますか？');
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
    await vi.waitFor(() => expect(text()).toMatch(/保存した曲：2曲 · \d+ KB/));

    buttonNamed('すべて消す').click();
    expect(text()).toContain('保存したすべての曲（2曲）を消しますか？途中まで訳した曲も消えます');
    expect((await storageSummary()).count).toBe(2); // nothing yet
    buttonNamed('消す').click();

    await vi.waitFor(() => expect(text()).toContain('保存した曲：0曲'));
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
    buttonNamed('この曲の保存データを消す').click();
    buttonNamed('やめる').click();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
