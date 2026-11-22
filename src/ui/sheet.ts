/*
 * The sheet: first-run (paste a key) and settings. One shadow-DOM host fixed to the viewport,
 * so Genius' CSS cannot reach our markup and ours cannot reach Genius (docs/DESIGN.md §2 row 8,
 * §4 copy, §6 tokens, §7 settings). Desktop: a 400px panel under the 設定 button. Phone: a bottom sheet.
 *
 * API keys never go into the DOM except as the value of the input while the reader types, and
 * as the masked tail of a saved key (••••abcd). The key is never logged, and error text is
 * scrubbed (scrubKey) before it is logged or stored.
 */
import { claudeKeyStatus, keyStatus, markKey, modelsFor, type KeyStatus } from '../llm/chain';
import { ClaudeProvider, clearClaudeBench } from '../llm/claude';
import { LLMError, errorDetail } from '../llm/errors';
import { currentSettings, loadSettings, setApiKey, setClaudeKey } from '../store/settings';
import { deleteAllSongs, exportSongs, importSongs, storageSummary } from '../store/songs';
import type { StopDetail } from '../core/types';
import { h } from './dom';
import css from './sheet.css';
import { formatDate, formatWhen } from './time';

/** `edition: false`: nothing is translated yet (a first request failed); only 直近のエラー is shown. */
export interface SheetSong { title: string; model?: string; translatedAt?: number; lastError?: StopDetail; edition?: boolean }

export interface OpenSheetOptions {
  mode: 'first-run' | 'settings';
  /** Desktop: the 設定 button the panel anchors under. */
  anchor?: HTMLElement | null;
  /** Shows the 「この曲」 section (settings mode) when given. */
  song?: SheetSong | null;
  /** Id of the song a request is writing right now (here or in another tab). インポート leaves it alone. */
  busySongId?: string | null;
  /** Called after the reader confirms 再翻訳. */
  onRetranslate?: () => void;
  /** After the reader confirms 削除 for this song. */
  onDeleteSong?: () => Promise<void> | void;
  /** First-run primary button, after the key is saved and verified. */
  onSaveAndTranslate?: () => void;
  /** `changed` = any key saved/removed, songs imported, or data deleted. */
  onClose?: (changed: boolean) => void;
}

/* ---------- copy (docs/DESIGN.md §4, verbatim) ---------- */

const COPY = {
  firstTitle: 'APIキーの設定',
  step1: 'Google AI Studioを開き、Googleアカウントでログインして、無料のAPIキーを作成します',
  step1Link: 'Google AI Studioを開く',
  step2: 'キーをコピーして、下の欄に貼り付けます',
  placeholder: 'APIキーを貼り付け',
  pasteKey: 'APIキーを入力してください',
  keyNote: 'キーはこのブラウザにのみ保存され、Google以外には送信されません。無料枠では、送信した歌詞などがGoogleのサービス改善に使用される場合があります',
  primary: '保存してこの曲を翻訳',
  secondary: '保存のみ',
  checking: '確認しています…',
  badKey: 'このキーは使用できません。もう一度コピーしてください',
  network: 'Googleに接続できませんでした。ネットワーク接続を確認してください',
  busyCheck: 'Googleが混雑しているため、確認できませんでした。しばらくしてから再試行してください',
  badKeyRow: 'もう一度コピーして貼り付けてください',
  keySaveFailed: 'キーを保存できませんでした。再試行してください',
  settingsTitle: 'Lyric Lensの設定',
  close: '閉じる',
  services: '翻訳に使用するAI',
  save: '保存',
  makeKey: 'Google AI Studioでキーを作成',
  removeKey: 'キーを削除',
  reenterKey: 'キーを再入力',
  statusMissing: '未設定',
  statusOk: '使用できます',
  statusBad: 'キーが無効です',
  song: 'この曲',
  lastError: '直近のエラー',
  retranslate: 'この曲を再翻訳',
  retranslateConfirm: '現在の訳を残したまま再翻訳し、完了後に新しい訳に置き換えます',
  retranslateOk: '再翻訳',
  deleteSong: 'この曲の訳を削除',
  deleteSongConfirm: 'この曲の保存済みの訳を削除します。この操作は取り消せません',
  deleteAllOk: 'すべて削除',
  data: '保存データ',
  dataLead: 'エクスポートしたファイルは、別の端末でインポートできます',
  exportData: 'エクスポート',
  importData: 'インポート',
  exportFailed: 'エクスポートできませんでした',
  importNothing: 'インポートできる新しい曲はありませんでした',
  importFailed: 'インポートできませんでした。Lyric Lensでエクスポートしたファイルを選択してください',
  deleteAll: 'すべて削除',
  deleteFailed: '削除できませんでした',
  nothingSaved: '保存済みの曲はありません',
  claudeMakeKey: 'Claude Consoleでキーを作成',
  claudeNetwork: 'Anthropicに接続できませんでした。ネットワーク接続を確認してください',
  claudeBusy: 'Anthropicが混雑しているため、確認できませんでした。しばらくしてから再試行してください',
  ok: '削除',
  cancel: 'キャンセル',
} as const;

const AI_STUDIO_URL = 'https://aistudio.google.com/app/apikey';

/** A key row: which service, how its key is checked (never a generation call), saved and judged. */
interface Service {
  id: 'gemini' | 'claude';
  label: string;
  makeKey: string;
  makeKeyUrl: string;
  network: string;
  busy: string;
  check(key: string): Promise<void>;
  store(key: string): Promise<string>;
  status(key: string): Promise<KeyStatus>;
}

const GEMINI: Service = {
  id: 'gemini',
  label: 'Google Gemini',
  makeKey: COPY.makeKey,
  makeKeyUrl: AI_STUDIO_URL,
  network: COPY.network,
  busy: COPY.busyCheck,
  check: async (key) => { await modelsFor(key, { refresh: true }); },
  store: async (key) => { if (key) await markKey(key, false); return (await setApiKey(key)).apiKey; },
  status: (key) => keyStatus(key),
};

/** Tried before Gemini when its key is saved (llm/claude.ts). */
const CLAUDE: Service = {
  id: 'claude',
  label: 'Anthropic Claude',
  makeKey: COPY.claudeMakeKey,
  makeKeyUrl: 'https://platform.claude.com/settings/keys',
  network: COPY.claudeNetwork,
  busy: COPY.claudeBusy,
  check: (key) => new ClaudeProvider(key).verify(),
  store: async (key) => { if (key) await clearClaudeBench(key); return (await setClaudeKey(key)).claudeKey; },
  status: (key) => claudeKeyStatus(key),
};


/* ---------- small helpers ---------- */

/** Inline on the host so page CSS (which can target any div) cannot move or hide it. */
const HOST_STYLE = [
  'all:initial', 'display:block', 'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483000',
].map((d) => `${d} !important`).join(';');

const GAP = 8;
const MARGIN = 8;
const MIN_HEIGHT = 160;

function isDesktop(): boolean {
  try {
    if (typeof window.matchMedia === 'function') return window.matchMedia('(min-width: 600px) and (pointer: fine)').matches;
  } catch { /* fall through */ }
  return window.innerWidth >= 600;
}

function prefersDark(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** Dark when the page was detected dark; otherwise the system preference decides. */
function wantsDark(): boolean {
  const root = document.documentElement;
  if (root.classList.contains('ll-dark') || root.getAttribute('data-ll-theme') === 'dark') return true;
  return prefersDark();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function formatSize(bytes: number): string {
  if (!(bytes > 0)) return '0 KB';
  const kb = bytes / 1024;
  if (kb < 1) return '1 KB';
  if (kb < 1023.5) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** A model id as a reader says it: gemini-3.5-flash-lite → "Gemini 3.5 Flash-Lite", gemma-4-31b-it
 *  → "Gemma 4 31B IT". An id that is not a Gemini or Gemma version stays as it is. */
export function modelLabel(id: string): string {
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d))?$/.exec(id);
  if (claude) return `Claude ${claude[1]!.charAt(0).toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  const m =/^(gemini|gemma)-(\d+(?:\.\d+)?)((?:-[a-z0-9.]+)*)$/.exec(id);
  if (!m) return id;
  const words: string[] = [];
  for (const part of m[3]!.split('-').filter(Boolean)) {
    if (part === 'lite' && words.length) words[words.length - 1] += '-Lite';
    else if (part === 'it') continue; // instruction-tuned: a build tag, not part of the name
    else if (/^\d+(?:\.\d+)?[bm]$/.test(part)) words.push(part.toUpperCase());
    else words.push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return [m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1), m[2]!, ...words].join(' ');
}

/** What a screen reader says for the masked key. */
function maskLabel(key: string): string {
  const k = key.trim();
  return k.length >= 8 ? `保存済みのキー（末尾${k.slice(-4)}）` : '保存済みのキー';
}

/** ••••abcd. A short key shows no tail at all. */
function maskKey(key: string): string {
  const k = key.trim();
  return k.length >= 8 ? `••••${k.slice(-4)}` : '••••';
}

function isAuthError(error: unknown): boolean {
  return error instanceof LLMError && error.kind === 'auth';
}

function isAborted(error: unknown): boolean {
  return error instanceof LLMError && error.kind === 'aborted';
}

/** Callbacks come from the page script; a failure there must not break the sheet. Never logs details. */
function safely(fn: () => unknown, label: string): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).then(undefined, () => console.error(`[Lyric Lens] sheet ${label} failed`));
    }
  } catch {
    console.error(`[Lyric Lens] sheet ${label} failed`);
  }
}

function focusEl(el: HTMLElement | null | undefined): void {
  try { el?.focus({ preventScroll: true }); } catch { /* not focusable */ }
}

/** File.text() is missing on older iOS Safari; FileReader is everywhere. */
function readFileText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read'));
    reader.readAsText(file);
  });
}

/** lyric-lens-20261026.json, from the reader's local date. */
function exportFileName(now = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `lyric-lens-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}.json`;
}

type RowKind = 'pending' | 'checking' | 'missing' | 'ok' | 'resting' | 'bad';

interface Row {
  id: string;
  service: Service;
  apiKey: string;
  kind: RowKind;
  until: number;
  message: string;
  busy: boolean;
  el: HTMLElement;
  dot: HTMLElement;
  statusEl: HTMLElement;
  msgEl: HTMLElement;
  controls: HTMLElement;
  mode: 'key' | 'input' | null;
  input: HTMLInputElement | null;
  removeButton: HTMLButtonElement | null;
}

function statusText(row: Row): string {
  switch (row.kind) {
    case 'missing': return COPY.statusMissing;
    case 'ok': return COPY.statusOk;
    case 'bad': return COPY.statusBad;
    case 'checking': return COPY.checking;
    case 'resting': {
      if (row.until <= 0) return COPY.statusOk;
      const when = formatWhen(row.until);
      if (row.service.id === 'claude') return `APIの残高がありません（${when}に再試行します）`;
      return `本日の無料枠を使い切りました（${when}から使用できます）`;
    }
    default: return '';
  }
}

/* ---------- the sheet ---------- */

interface Active { close(): void }
let active: Active | null = null;
let idSeq = 0;

export function closeSheet(): void {
  active?.close();
}

export function openSheet(options: OpenSheetOptions): void {
  active?.close();
  active = mount(options);
}

function mount(options: OpenSheetOptions): Active {
  const settingsMode = options.mode === 'settings';
  const anchor = options.anchor ?? null;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closed = false;
  let changed = false;

  /* ----- host + shadow root ----- */

  const host = document.createElement('div');
  host.className = 'll-sheet-host';
  host.setAttribute('lang', 'ja');
  host.style.cssText = HOST_STYLE;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = typeof css === 'string' ? css : '';

  const titleId = `ll-sheet-title-${(idSeq += 1)}`;
  const closeButton = h('button', { class: 'btn', type: 'button', 'data-v': 'close', onClick: () => { finish(); } }, COPY.close);
  const body = h('div', { class: 'body' });
  const panel = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabIndex: -1 },
    h('div', { class: 'head' },
      h('h2', { class: 'title', id: titleId }, settingsMode ? COPY.settingsTitle : COPY.firstTitle),
      closeButton),
    body);
  const backdrop = h('div', { class: 'backdrop' }, panel);
  const rootEl = h('div', { class: 'root', lang: 'ja', 'data-theme': wantsDark() ? 'dark' : 'light', 'data-layout': isDesktop() ? 'desktop' : 'phone' }, backdrop);
  shadow.append(style, rootEl);

  /* ----- keep every event away from Genius ----- */

  for (const type of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress']) {
    host.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
  }

  /* ----- closing ----- */

  // A press that starts inside the panel (e.g. selecting text in the input) must not close the sheet
  // when it ends on the backdrop.
  let pressedInPanel = false;
  const markPress = (): void => { pressedInPanel = true; };
  panel.addEventListener('pointerdown', markPress);
  panel.addEventListener('mousedown', markPress);
  backdrop.addEventListener('click', (e) => {
    const outside = e.target === backdrop && !pressedInPanel;
    pressedInPanel = false;
    if (outside) finish();
  });

  function focusables(): HTMLElement[] {
    // The hidden file input behind 読み込む cannot take focus: counting it would break the Tab wrap.
    return Array.from(panel.querySelectorAll<HTMLElement>('a[href], button, input:not([type="file"]), select, textarea'))
      .filter((el) => !(el as HTMLButtonElement).disabled);
  }

  rootEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      finish();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) { e.preventDefault(); return; }
    const current = (shadow as ShadowRoot & { activeElement: Element | null }).activeElement;
    if (e.shiftKey && (current === first || current === panel)) { e.preventDefault(); focusEl(last); }
    else if (!e.shiftKey && current === last) { e.preventDefault(); focusEl(first); }
  });

  // Escape also works when focus has wandered out of the sheet (e.g. back on the page).
  const onDocumentKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    finish();
  };
  document.addEventListener('keydown', onDocumentKey, true);

  /* ----- placement ----- */

  let side: 'below' | 'above' = 'below';
  let cancelPlace: (() => void) | null = null;
  let wantRedecide = false;

  function place(redecide: boolean): void {
    const desktop = isDesktop();
    const s = panel.style;
    rootEl.dataset.layout = desktop ? 'desktop' : 'phone';
    s.left = s.top = s.bottom = s.maxHeight = '';
    if (!desktop) { delete rootEl.dataset.place; return; }
    const rect = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
    if (!rect || (rect.width === 0 && rect.height === 0)) { rootEl.dataset.place = 'center'; return; }
    rootEl.dataset.place = 'anchor';

    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    // The panel's width in sheet.css; the right edge must meet 設定's.
    const width = Math.min(360, vw - 2 * MARGIN);
    const cap = vh * 0.7;
    const spaceBelow = vh - rect.bottom - GAP - MARGIN;
    const spaceAbove = rect.top - GAP - MARGIN;

    if (redecide) {
      // Natural height: measure with the cap lifted, then choose the side with room.
      s.maxHeight = 'none';
      s.top = '0px';
      s.left = '0px';
      const natural = panel.offsetHeight;
      side = spaceBelow >= Math.min(natural, cap) || spaceBelow >= spaceAbove ? 'below' : 'above';
    }
    const room = side === 'below' ? spaceBelow : spaceAbove;
    // 設定 is the rightmost link of the head row: the panel hangs from the button's right edge
    // and opens leftwards over the lyrics column (kept inside the viewport on a narrow window).
    s.left = `${clamp(rect.right - width, MARGIN, vw - width - MARGIN)}px`;
    s.maxHeight = `${Math.max(MIN_HEIGHT, Math.min(cap, room))}px`;
    if (side === 'below') {
      s.top = `${clamp(rect.bottom + GAP, MARGIN, vh - MIN_HEIGHT - MARGIN)}px`;
      s.bottom = 'auto';
    } else {
      s.bottom = `${clamp(vh - rect.top + GAP, MARGIN, vh - MIN_HEIGHT - MARGIN)}px`;
      s.top = 'auto';
    }
  }

  function schedulePlace(redecide: boolean): void {
    wantRedecide = wantRedecide || redecide;
    if (cancelPlace) return;
    const run = (): void => {
      cancelPlace = null;
      const again = wantRedecide;
      wantRedecide = false;
      if (!closed) place(again);
    };
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(run);
      cancelPlace = () => cancelAnimationFrame(id);
    } else {
      const id = setTimeout(run, 16);
      cancelPlace = () => clearTimeout(id);
    }
  }

  const onResize = (): void => schedulePlace(true);
  const onScroll = (): void => schedulePlace(false);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  const queries: MediaQueryList[] = [];
  try {
    if (typeof window.matchMedia === 'function') {
      const layoutQuery = window.matchMedia('(min-width: 600px) and (pointer: fine)');
      const schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      layoutQuery.addEventListener('change', onResize);
      schemeQuery.addEventListener('change', onTheme);
      queries.push(layoutQuery, schemeQuery);
    }
  } catch { /* old browsers */ }

  function onTheme(): void {
    rootEl.dataset.theme = wantsDark() ? 'dark' : 'light';
  }

  /* ----- finishing ----- */

  function finish(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onDocumentKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll, true);
    for (const q of queries) { try { q.removeEventListener('change', onResize); q.removeEventListener('change', onTheme); } catch { /* ignore */ } }
    cancelPlace?.();
    cancelPlace = null;
    for (const input of Array.from(shadow.querySelectorAll('input'))) input.value = '';
    host.remove();
    if (active === handle) active = null;
    if (previousFocus?.isConnected) focusEl(previousFocus);
    const result = changed;
    safely(() => options.onClose?.(result), 'onClose');
  }

  const handle: Active = { close: finish };

  /* ----- shared widgets ----- */

  const button = (text: string, variant: 'text' | 'outline' | 'solid', onClick: () => void): HTMLButtonElement =>
    h('button', { class: 'btn', type: 'button', 'data-v': variant, onClick }, text);

  const externalLink = (text: string, href: string): HTMLAnchorElement =>
    h('a', { class: 'link', href, target: '_blank', rel: 'noopener noreferrer' }, text);

  /** The key field. A password input outside any <form>, so managers do not offer to save it. */
  function keyInput(label: string, onSubmit: () => void, onEdit: () => void): HTMLInputElement {
    const input = h('input', {
      class: 'input',
      type: 'password',
      placeholder: COPY.placeholder,
      autocomplete: 'off',
      spellcheck: false,
      autocapitalize: 'off',
      autocorrect: 'off',
      'aria-label': label,
      'data-lpignore': 'true',
      'data-1p-ignore': true,
      onInput: onEdit,
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); onSubmit(); }
      },
    });
    input.setAttribute('autocomplete', 'off');
    return input;
  }

  /** Verifies a key with the provider's model list (never a generation call). */
  async function verify(apiKey: string, service: Service = GEMINI): Promise<'ok' | 'auth' | 'network' | 'busy' | 'aborted'> {
    try {
      await service.check(apiKey);
      return 'ok';
    } catch (error) {
      if (isAborted(error)) return 'aborted';
      // What failed, for the console (the key is scrubbed): the row only says busy or offline.
      console.warn('[Lyric Lens] key check', service.id, error instanceof LLMError ? errorDetail(error, 300) : String(error));
      if (isAuthError(error)) return 'auth';
      // Only a failed connection is the reader's to fix; a 503, 429 or timeout is Google's.
      return error instanceof LLMError && error.kind === 'network' ? 'network' : 'busy';
    }
  }

  /** Replaces a button row with a question and two answers; キャンセル puts the buttons back. */
  function askInline(zone: HTMLElement, trigger: HTMLElement, spec: { message: string; ok: string; focusCancel: boolean; onOk: (done: () => void) => void }): void {
    const original = Array.from(zone.childNodes);
    const restore = (): void => { zone.replaceChildren(...original); };
    const cancel = button(COPY.cancel, 'text', () => { restore(); focusEl(trigger); });
    const ok: HTMLButtonElement = button(spec.ok, 'solid', () => {
      ok.disabled = true;
      cancel.disabled = true;
      spec.onOk(() => { ok.disabled = false; cancel.disabled = false; });
    });
    zone.replaceChildren(h('div', { class: 'confirm' },
      h('p', { class: 'confirm-text', role: 'alert' }, spec.message),
      h('div', { class: 'actions' }, ok, cancel)));
    focusEl(spec.focusCancel ? cancel : ok);
  }

  /* ===================================================================== */
  /* first run                                                               */
  /* ===================================================================== */

  function buildFirstRun(): { focus: () => void } {
    let busy = false;
    const message = h('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
    const say = (text: string, kind: '' | 'error' = ''): void => {
      message.textContent = text;
      if (kind) message.dataset.kind = kind; else delete message.dataset.kind;
    };
    const input = keyInput('APIキー', () => { void submit(true); }, () => {
      if (!busy && message.textContent) { say(''); input.removeAttribute('aria-invalid'); }
    });
    const primary = button(COPY.primary, 'solid', () => { void submit(true); });
    const secondary = button(COPY.secondary, 'outline', () => { void submit(false); });

    function setBusy(on: boolean): void {
      busy = on;
      input.disabled = on;
      primary.disabled = on;
      secondary.disabled = on;
      body.setAttribute('aria-busy', String(on));
    }

    async function submit(andTranslate: boolean): Promise<void> {
      if (busy || closed) return;
      const key = input.value.trim();
      if (!key) { say(COPY.pasteKey, 'error'); focusEl(input); return; }
      input.removeAttribute('aria-invalid');
      setBusy(true);
      say(COPY.checking);
      const verdict = await verify(key);
      if (closed || verdict === 'aborted') return;
      if (verdict !== 'ok') {
        setBusy(false);
        input.setAttribute('aria-invalid', 'true');
        say(verdict === 'auth' ? COPY.badKey : verdict === 'busy' ? COPY.busyCheck : COPY.network, 'error');
        focusEl(input);
        return;
      }
      try {
        await markKey(key, false);
        await setApiKey(key);
      } catch {
        if (closed) return;
        setBusy(false);
        say(COPY.keySaveFailed, 'error');
        focusEl(input);
        return;
      }
      if (closed) return;
      changed = true;
      finish();
      if (andTranslate) safely(() => options.onSaveAndTranslate?.(), 'onSaveAndTranslate');
    }

    body.append(
      h('ol', { class: 'steps' },
        h('li', null, h('span', null, COPY.step1), externalLink(COPY.step1Link, AI_STUDIO_URL)),
        h('li', null, COPY.step2)),
      input,
      message,
      h('p', { class: 'note' }, COPY.keyNote),
      h('div', { class: 'actions', 'data-stack': 'true' }, primary, secondary));

    return { focus: () => focusEl(input) };
  }

  /* ===================================================================== */
  /* settings                                                                */
  /* ===================================================================== */

  function buildSettings(): { focus: () => void } {
    const servicesBox = h('div', { class: 'services' });
    body.append(h('section', { class: 'section' },
      h('h3', { class: 'section-title' }, COPY.services),
      servicesBox));

    const rows: Row[] = [];

    /* -- one service row -- */

    function paintRow(row: Row): void {
      row.dot.dataset.s = row.kind;
      row.statusEl.dataset.s = row.kind;
      row.statusEl.textContent = statusText(row);
      row.msgEl.textContent = row.message;
      if (row.message) row.msgEl.dataset.kind = 'error'; else delete row.msgEl.dataset.kind;
      row.el.setAttribute('aria-busy', String(row.busy));
      const want = row.apiKey.trim() ? 'key' : 'input';
      if (row.mode !== want) buildControls(row, want);
      // A rejected key is replaced, not merely removed: say so, since that is the next step.
      if (row.removeButton) row.removeButton.textContent = row.kind === 'bad' ? COPY.reenterKey : COPY.removeKey;
      if (row.input) {
        row.input.disabled = row.busy;
        if (row.kind === 'bad') row.input.setAttribute('aria-invalid', 'true'); else row.input.removeAttribute('aria-invalid');
      }
      for (const b of Array.from(row.controls.querySelectorAll('button'))) b.disabled = row.busy;
    }

    function buildControls(row: Row, mode: 'key' | 'input'): void {
      row.mode = mode;
      row.input = null;
      row.removeButton = null;
      if (mode === 'key') {
        const remove = button(COPY.removeKey, 'text', () => { void removeKey(row); });
        row.removeButton = remove;
        row.controls.replaceChildren(h('div', { class: 'inline' }, h('span', { class: 'mask', role: 'img', 'aria-label': maskLabel(row.apiKey) }, maskKey(row.apiKey)), remove));
        return;
      }
      const input = keyInput(`${row.service.label}のAPIキー`, () => { void saveKey(row); }, () => {
        if (!row.busy && (row.kind === 'bad' || row.message)) { row.kind = 'missing'; row.message = ''; paintRow(row); }
      });
      row.input = input;
      row.controls.replaceChildren(h('div', { class: 'inline' }, input, button(COPY.save, 'outline', () => { void saveKey(row); })));
      row.controls.append(externalLink(row.service.makeKey, row.service.makeKeyUrl));
    }

    async function saveKey(row: Row): Promise<void> {
      const input = row.input;
      if (!input || row.busy || closed) return;
      const key = input.value.trim();
      if (!key) { focusEl(input); return; }
      row.busy = true;
      row.kind = 'checking';
      row.message = '';
      paintRow(row);
      const verdict = await verify(key, row.service);
      if (closed || verdict === 'aborted') return;
      if (verdict !== 'ok') {
        row.busy = false;
        row.kind = verdict === 'auth' ? 'bad' : 'missing';
        row.message = verdict === 'auth' ? COPY.badKeyRow : verdict === 'busy' ? row.service.busy : row.service.network;
        paintRow(row);
        focusEl(row.input);
        return;
      }
      try {
        row.apiKey = await row.service.store(key);
      } catch {
        if (closed) return;
        row.busy = false;
        row.kind = 'missing';
        row.message = COPY.keySaveFailed;
        paintRow(row);
        focusEl(row.input);
        return;
      }
      if (closed) return;
      changed = true;
      const status = await statusOf(row);
      if (closed) return;
      row.busy = false;
      row.message = '';
      applyStatus(row, status);
      paintRow(row);
      focusEl(row.removeButton);
    }

    async function removeKey(row: Row): Promise<void> {
      if (row.busy || closed) return;
      const wasBad = row.kind === 'bad';
      row.busy = true;
      paintRow(row);
      try {
        row.apiKey = await row.service.store('');
      } catch {
        if (closed) return;
        row.busy = false;
        paintRow(row);
        return;
      }
      if (closed) return;
      changed = true;
      row.busy = false;
      row.kind = 'missing';
      row.until = 0;
      row.message = '';
      paintRow(row);
      // The button that had focus is gone. After キーを再入力 the reader is here to paste a new
      // key, so the field gets focus even on a phone. After キーを削除 on a phone, focusing the
      // input would raise the keyboard for nothing.
      if (isDesktop() || wasBad) focusEl(row.input);
      else { row.el.tabIndex = -1; focusEl(row.el); }
    }

    function applyStatus(row: Row, status: KeyStatus): void {
      row.kind = status.kind;
      row.until = status.kind === 'resting' ? status.until : 0;
    }

    async function statusOf(row: Row): Promise<KeyStatus> {
      try {
        return await row.service.status(row.apiKey);
      } catch {
        return row.apiKey.trim() ? { kind: 'ok' } : { kind: 'missing' };
      }
    }

    function buildRow(service: Service, apiKey: string): Row {
      const id = service.id;
      const dot = h('span', { class: 'dot', 'aria-hidden': 'true' });
      const statusEl = h('span', { class: 'status' });
      const msgEl = h('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
      const controls = h('div', { class: 'controls' });
      const el = h('div', { class: 'service', 'data-service': id },
        h('div', { class: 'service-head' }, dot, h('span', { class: 'service-name' }, service.label), statusEl),
        controls,
        msgEl);
      return {
        id, service, apiKey, kind: apiKey.trim() ? 'pending' : 'missing', until: 0, message: '', busy: false,
        el, dot, statusEl, msgEl, controls, mode: null, input: null, removeButton: null,
      };
    }

    /* -- this song -- */

    if (options.song) {
      const song = options.song;
      const parts: string[] = [];
      if (song.translatedAt && Number.isFinite(song.translatedAt)) parts.push(`${formatDate(song.translatedAt)}に`);
      if (song.model) parts.push(`${modelLabel(song.model)}で`);
      const zone = h('div', { class: 'zone' });
      const retranslate: HTMLButtonElement = button(COPY.retranslate, 'outline', () => {
        askInline(zone, retranslate, {
          message: COPY.retranslateConfirm,
          ok: COPY.retranslateOk,
          focusCancel: false,
          onOk: () => {
            finish();
            safely(() => options.onRetranslate?.(), 'onRetranslate');
          },
        });
      });
      const deleteSong: HTMLButtonElement = button(COPY.deleteSong, 'text', () => {
        askInline(zone, deleteSong, {
          message: COPY.deleteSongConfirm,
          ok: COPY.ok,
          focusCancel: true,
          onOk: (done) => {
            void (async () => {
              try {
                await options.onDeleteSong?.();
              } catch {
                console.error('[Lyric Lens] sheet onDeleteSong failed');
                if (!closed) done();
                return;
              }
              if (closed) return;
              changed = true;
              finish();
            })();
          },
        });
      });
      zone.append(h('div', { class: 'actions' }, retranslate, deleteSong));
      const edition = song.edition !== false;
      body.append(h('section', { class: 'section' },
        h('h3', { class: 'section-title' }, COPY.song),
        edition && parts.length ? h('p', { class: 'line' }, `${parts.join('')}翻訳しました`) : null,
        song.lastError
          ? h('details', { class: 'error-detail' },
            h('summary', {}, COPY.lastError),
            h('p', { class: 'error-head' }, [song.lastError.model ? modelLabel(song.lastError.model) : '—', song.lastError.status || '—', song.lastError.kind].join(' · ')),
            song.lastError.text ? h('p', { class: 'error-text' }, song.lastError.text) : null)
          : null,
        edition ? zone : null));
    }

    /* -- saved data -- */

    let summary: { count: number; bytes: number } | null = null;
    let deleting = false;
    let transferring = false;
    const dataBusy = (): boolean => deleting || transferring;
    const summaryEl = h('p', { class: 'line' });
    const dataMsg = h('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
    const sayData = (text: string, kind: '' | 'error' = ''): void => {
      dataMsg.textContent = text;
      if (kind) dataMsg.dataset.kind = kind; else delete dataMsg.dataset.kind;
    };
    const zone = h('div', { class: 'zone' });

    /* エクスポート: one JSON file with every saved song. Nothing is sent anywhere. */
    const exportButton: HTMLButtonElement = button(COPY.exportData, 'text', () => { void exportData(); });

    async function exportData(): Promise<void> {
      if (dataBusy() || closed || !summary || summary.count === 0) return;
      const count = summary.count;
      transferring = true;
      sayData('');
      paintSummary();
      let failed = false;
      try {
        const url = URL.createObjectURL(new Blob([await exportSongs()], { type: 'application/json' }));
        const link = h('a', { href: url, download: exportFileName(), hidden: true });
        shadow.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } catch {
        failed = true;
        console.error('[Lyric Lens] sheet exportSongs failed');
      }
      transferring = false;
      if (closed) return;
      paintSummary();
      if (failed) sayData(COPY.exportFailed, 'error'); else sayData(`${count}曲をエクスポートしました`);
      focusEl(exportButton);
    }

    /* インポート: a hidden file input inside the shadow root; the visible button opens it. */
    const importButton: HTMLButtonElement = button(COPY.importData, 'text', () => { fileInput.click(); });
    const fileInput = h('input', {
      type: 'file',
      accept: 'application/json',
      hidden: true,
      tabIndex: -1,
      'aria-hidden': 'true',
      onChange: () => {
        const file = fileInput.files?.[0];
        fileInput.value = ''; // the same file can be chosen again
        if (file) void importFile(file);
      },
    });

    async function importFile(file: Blob): Promise<void> {
      if (dataBusy() || closed) return;
      transferring = true;
      sayData('');
      paintSummary();
      let written = -1; // -1 = not a usable file
      try {
        written = await importSongs(await readFileText(file), options.busySongId);
        if (written > 0) changed = true;
      } catch { /* the message below says it; the file's contents are never logged */ }
      transferring = false;
      if (closed) return;
      await refreshSummary();
      if (closed) return;
      if (written < 0) sayData(COPY.importFailed, 'error');
      else sayData(written === 0 ? COPY.importNothing : `${written}曲をインポートしました`);
      focusEl(importButton);
    }

    const deleteAll: HTMLButtonElement = button(COPY.deleteAll, 'text', () => {
      if (!summary) return;
      const count = summary.count;
      askInline(zone, deleteAll, {
        message: `保存済みの${count}曲の訳をすべて削除します。この操作は取り消せません`,
        ok: COPY.deleteAllOk,
        focusCancel: true,
        onOk: (done) => {
          deleting = true;
          sayData('');
          void (async () => {
            let failed = false;
            try {
              await deleteAllSongs();
              changed = true;
            } catch {
              console.error('[Lyric Lens] sheet deleteAllSongs failed');
              failed = true;
            }
            deleting = false;
            if (closed) return;
            done();
            await refreshSummary();
            if (closed) return;
            zone.replaceChildren(dataActions);
            paintSummary();
            if (failed) sayData(COPY.deleteFailed, 'error');
            focusEl(deleteAll.disabled ? importButton : deleteAll);
          })();
        },
      });
    });
    const dataActions = h('div', { class: 'actions' }, exportButton, importButton, deleteAll);
    zone.append(dataActions);

    function paintSummary(): void {
      summaryEl.textContent = !summary ? '保存済みの曲：…' : summary.count ? `${summary.count}曲を保存しています（${formatSize(summary.bytes)}）` : COPY.nothingSaved;
      const none = !summary || summary.count === 0;
      exportButton.disabled = none || dataBusy();
      importButton.disabled = dataBusy();
      deleteAll.disabled = none || dataBusy();
      zone.setAttribute('aria-busy', String(dataBusy()));
    }

    async function refreshSummary(): Promise<void> {
      try {
        summary = await storageSummary();
      } catch {
        summary = null;
      }
      if (!closed) paintSummary();
    }

    paintSummary();
    body.append(h('section', { class: 'section' },
      h('h3', { class: 'section-title' }, COPY.data),
      summaryEl,
      zone,
      h('p', { class: 'section-lead' }, COPY.dataLead),
      dataMsg,
      fileInput));
    void refreshSummary();

    /* -- load the services -- */

    const firstEmptyInput = (): HTMLInputElement | null => rows.find((r) => r.service.id === 'gemini' && r.input)?.input ?? null;

    void (async () => {
      let settings: { apiKey: string; claudeKey: string };
      try {
        settings = await loadSettings();
      } catch {
        settings = currentSettings();
      }
      if (closed) return;
      for (const [service, key] of [[GEMINI, settings.apiKey], [CLAUDE, settings.claudeKey]] as const) {
        const row = buildRow(service, key);
        rows.push(row);
        servicesBox.append(row.el);
        paintRow(row);
      }
      place(true);
      // 閉じる has focus until now.
      const untouched = (shadow as ShadowRoot & { activeElement: Element | null }).activeElement === closeButton;
      // On a desktop, move to the key field when it is empty; a phone keyboard would cover the sheet.
      const target = firstEmptyInput();
      if (target && isDesktop() && untouched) focusEl(target);

      await Promise.all(rows.map(async (row) => {
        const key = row.apiKey;
        if (!key.trim()) return;
        const status = await statusOf(row);
        if (closed || row.busy || row.apiKey !== key) return;
        applyStatus(row, status);
        paintRow(row);
      }));
    })();

    return { focus: () => focusEl(closeButton) };
  }

  /* ----- mount ----- */

  document.body.appendChild(host);
  const initial = settingsMode ? buildSettings() : buildFirstRun();
  place(true);
  initial.focus();
  return handle;
}
