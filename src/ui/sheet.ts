/*
 * The sheet: first-run (paste a key) and settings. One shadow-DOM host fixed to the viewport,
 * so Genius' CSS cannot reach our markup and ours cannot reach Genius (docs/DESIGN.md §2 row 8,
 * §4 copy, §6 tokens, §7 settings). Desktop: a 400px panel under the 設定 button. Phone: a bottom sheet.
 *
 * API keys never go into the DOM except as the value of the input while the reader types, and
 * as the masked tail of a saved key (••••abcd). Errors from the providers are never logged.
 */
import { keyStatus, markKey, modelsFor, type KeyStatus } from '../llm/chain';
import { LLMError } from '../llm/errors';
import { currentSettings, loadSettings, setApiKey } from '../store/settings';
import { deleteAllSongs, exportSongs, importSongs, storageSummary } from '../store/songs';
import { h } from './dom';
import css from './sheet.css';
import { formatDate, formatWhen } from './time';

export interface SheetSong { title: string; model?: string; translatedAt?: number }

export interface OpenSheetOptions {
  mode: 'first-run' | 'settings';
  /** Desktop: the 設定 button the panel anchors under. */
  anchor?: HTMLElement | null;
  /** Shows the 「この曲」 section (settings mode) when given. */
  song?: SheetSong | null;
  /** Id of the song a request is writing right now (here or in another tab). 読み込む leaves it alone. */
  busySongId?: string | null;
  /** Called after the reader confirms 訳し直す. */
  onRetranslate?: () => void;
  /** After the reader confirms 消す for this song. */
  onDeleteSong?: () => Promise<void> | void;
  /** First-run primary button, after the key is saved and verified. */
  onSaveAndTranslate?: () => void;
  /** `changed` = any key saved/removed, songs imported, or data deleted. */
  onClose?: (changed: boolean) => void;
}

/* ---------- copy (docs/DESIGN.md §4, verbatim) ---------- */

const COPY = {
  firstTitle: '日本語訳をはじめる',
  step1: 'Google AI Studio を開き、Googleアカウントでログインして無料のAPIキーを作ります',
  step1Link: 'Google AI Studio を開く',
  step2: 'キーをコピーして、下に貼り付けます',
  placeholder: 'APIキーを貼り付け',
  keyNote: 'キーはこのブラウザのユーザースクリプト保存領域にだけ置かれ、Google 以外には送られません',
  primary: '保存してこの曲を訳す',
  secondary: '保存だけする',
  checking: '確かめています…',
  badKey: 'このキーは使えませんでした。コピーし直してください',
  network: '確かめられませんでした。接続を確認してください',
  settingsTitle: 'Lyric Lens の設定',
  close: '閉じる',
  services: '翻訳に使うAI',
  save: '保存',
  makeKey: 'キーを作る',
  removeKey: 'キーを消す',
  reenterKey: 'キーを入れ直す',
  statusMissing: '未設定',
  statusOk: '使えます',
  statusBad: 'キーが使えません',
  song: 'この曲',
  retranslate: 'この曲を訳し直す',
  retranslateConfirm: 'この曲を訳し直しますか？無料枠を1回使います。終わるまで今の訳はそのまま表示されます',
  retranslateOk: '訳し直す',
  deleteSong: 'この曲の保存データを消す',
  deleteSongConfirm: 'この曲の保存した訳を消しますか？',
  data: '保存データ',
  dataLead: '書き出したファイルは、別の端末でも読み込めます',
  exportData: '書き出す',
  importData: '読み込む',
  exportFailed: '書き出せませんでした',
  importNothing: '新しく読み込める曲はありませんでした',
  importFailed: '読み込めませんでした。Lyric Lens で書き出したファイルを選んでください',
  deleteAll: 'すべて消す',
  ok: '消す',
  cancel: 'やめる',
} as const;

const AI_STUDIO_URL = 'https://aistudio.google.com/app/apikey';

const SERVICE_LABEL = 'Google AI Studio（Gemini）';

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
      // "今日は明日 16:00まで休み" reads wrong: drop 今日は when the reset is tomorrow.
      return when.startsWith('明日') ? `${when}まで休み` : `今日は${when}まで休み`;
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
    const width = Math.min(400, vw - 2 * MARGIN);
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
  async function verify(apiKey: string): Promise<'ok' | 'auth' | 'network' | 'aborted'> {
    try {
      await modelsFor(apiKey, { refresh: true });
      return 'ok';
    } catch (error) {
      if (isAborted(error)) return 'aborted';
      return isAuthError(error) ? 'auth' : 'network';
    }
  }

  /** Replaces a button row with a question and two answers; やめる puts the buttons back. */
  function askInline(zone: HTMLElement, trigger: HTMLElement, spec: { message: string; ok: string; focusCancel: boolean; onOk: (done: () => void) => void }): void {
    const original = Array.from(zone.childNodes);
    const restore = (): void => { zone.replaceChildren(...original); };
    const cancel = button(COPY.cancel, 'text', () => { restore(); focusEl(trigger); });
    const ok: HTMLButtonElement = button(spec.ok, 'outline', () => {
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
      if (!key) { focusEl(input); return; }
      input.removeAttribute('aria-invalid');
      setBusy(true);
      say(COPY.checking);
      const verdict = await verify(key);
      if (closed || verdict === 'aborted') return;
      if (verdict !== 'ok') {
        setBusy(false);
        input.setAttribute('aria-invalid', 'true');
        say(verdict === 'auth' ? COPY.badKey : COPY.network, 'error');
        focusEl(input);
        return;
      }
      try {
        await markKey(key, false);
        await setApiKey(key);
      } catch {
        if (closed) return;
        setBusy(false);
        say(COPY.network, 'error');
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
        row.controls.replaceChildren(h('div', { class: 'inline' }, h('span', { class: 'mask' }, maskKey(row.apiKey)), remove));
        return;
      }
      const input = keyInput(`${SERVICE_LABEL} のAPIキー`, () => { void saveKey(row); }, () => {
        if (!row.busy && (row.kind === 'bad' || row.message)) { row.kind = 'missing'; row.message = ''; paintRow(row); }
      });
      row.input = input;
      row.controls.replaceChildren(h('div', { class: 'inline' }, input, button(COPY.save, 'outline', () => { void saveKey(row); })));
      row.controls.append(externalLink(COPY.makeKey, AI_STUDIO_URL));
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
      const verdict = await verify(key);
      if (closed || verdict === 'aborted') return;
      if (verdict !== 'ok') {
        row.busy = false;
        row.kind = verdict === 'auth' ? 'bad' : 'missing';
        row.message = verdict === 'auth' ? COPY.badKey : COPY.network;
        paintRow(row);
        focusEl(row.input);
        return;
      }
      try {
        await markKey(key, false);
        row.apiKey = (await setApiKey(key)).apiKey;
      } catch {
        if (closed) return;
        row.busy = false;
        row.kind = 'missing';
        row.message = COPY.network;
        paintRow(row);
        focusEl(row.input);
        return;
      }
      if (closed) return;
      changed = true;
      const status = await statusOf(row.apiKey);
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
        row.apiKey = (await setApiKey('')).apiKey;
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
      // The button that had focus is gone. After キーを入れ直す the reader is here to paste a new
      // key, so the field gets focus even on a phone. After キーを消す on a phone, focusing the
      // input would raise the keyboard for nothing.
      if (isDesktop() || wasBad) focusEl(row.input);
      else { row.el.tabIndex = -1; focusEl(row.el); }
    }

    function applyStatus(row: Row, status: KeyStatus): void {
      row.kind = status.kind;
      row.until = status.kind === 'resting' ? status.until : 0;
    }

    async function statusOf(apiKey: string): Promise<KeyStatus> {
      try {
        return await keyStatus(apiKey);
      } catch {
        return apiKey.trim() ? { kind: 'ok' } : { kind: 'missing' };
      }
    }

    function buildRow(apiKey: string): Row {
      const id = 'gemini';
      const dot = h('span', { class: 'dot', 'aria-hidden': 'true' });
      const statusEl = h('span', { class: 'status' });
      const msgEl = h('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
      const controls = h('div', { class: 'controls' });
      const el = h('div', { class: 'service', 'data-service': id },
        h('div', { class: 'service-head' }, dot, h('span', { class: 'service-name' }, SERVICE_LABEL), statusEl),
        controls,
        msgEl);
      return {
        id, apiKey, kind: apiKey.trim() ? 'pending' : 'missing', until: 0, message: '', busy: false,
        el, dot, statusEl, msgEl, controls, mode: null, input: null, removeButton: null,
      };
    }

    /* -- this song -- */

    if (options.song) {
      const song = options.song;
      const parts: string[] = [];
      if (song.model) parts.push(song.model);
      if (song.translatedAt && Number.isFinite(song.translatedAt)) parts.push(formatDate(song.translatedAt));
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
      body.append(h('section', { class: 'section' },
        h('h3', { class: 'section-title' }, COPY.song),
        parts.length ? h('p', { class: 'line' }, `この曲の訳：${parts.join(' · ')}`) : null,
        zone));
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

    /* 書き出す: one JSON file with every saved song. Nothing is sent anywhere. */
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
      if (failed) sayData(COPY.exportFailed, 'error'); else sayData(`${count}曲を書き出しました`);
      focusEl(exportButton);
    }

    /* 読み込む: a hidden file input inside the shadow root; the visible button opens it. */
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
      else sayData(written === 0 ? COPY.importNothing : `${written}曲を読み込みました`);
      focusEl(importButton);
    }

    const deleteAll: HTMLButtonElement = button(COPY.deleteAll, 'text', () => {
      if (!summary) return;
      const count = summary.count;
      askInline(zone, deleteAll, {
        message: `保存したすべての曲（${count}曲）を消しますか？途中まで訳した曲も消えます`,
        ok: COPY.ok,
        focusCancel: true,
        onOk: (done) => {
          deleting = true;
          void (async () => {
            try {
              await deleteAllSongs();
              changed = true;
            } catch {
              console.error('[Lyric Lens] sheet deleteAllSongs failed');
            }
            deleting = false;
            if (closed) return;
            done();
            await refreshSummary();
            if (closed) return;
            zone.replaceChildren(dataActions);
            paintSummary();
            focusEl(deleteAll.disabled ? importButton : deleteAll);
          })();
        },
      });
    });
    const dataActions = h('div', { class: 'actions' }, exportButton, importButton, deleteAll);
    zone.append(dataActions);

    function paintSummary(): void {
      summaryEl.textContent = summary ? `保存した曲：${summary.count}曲 · ${formatSize(summary.bytes)}` : '保存した曲：…';
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
      h('p', { class: 'section-lead' }, COPY.dataLead),
      summaryEl,
      zone,
      dataMsg,
      fileInput));
    void refreshSummary();

    /* -- load the services -- */

    const firstEmptyInput = (): HTMLInputElement | null => rows.find((r) => r.input)?.input ?? null;

    void (async () => {
      let apiKey: string;
      try {
        apiKey = (await loadSettings()).apiKey;
      } catch {
        apiKey = currentSettings().apiKey;
      }
      if (closed) return;
      const row = buildRow(apiKey);
      rows.push(row);
      servicesBox.append(row.el);
      paintRow(row);
      place(true);
      // 閉じる has focus until now.
      const untouched = (shadow as ShadowRoot & { activeElement: Element | null }).activeElement === closeButton;
      // On a desktop, move to the key field when it is empty; a phone keyboard would cover the sheet.
      const target = firstEmptyInput();
      if (target && isDesktop() && untouched) focusEl(target);

      if (!row.apiKey.trim()) return;
      const status = await statusOf(row.apiKey);
      if (closed || row.busy || row.apiKey !== apiKey) return;
      applyStatus(row, status);
      paintRow(row);
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
