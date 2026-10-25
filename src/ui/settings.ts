/*
 * Settings dialog. Works on a deep copy of the stored settings: nothing is written until
 * "保存" is pressed, and cancelling (×, Escape, backdrop) leaves the stored settings alone.
 * The only exceptions are the two housekeeping buttons in "保存データ", which act at once.
 */
import { clearCooldowns, createProvider, modelsFor } from '../llm/chain';
import { LLMError } from '../llm/errors';
import { PRESETS, presetFor, type Preset } from '../llm/presets';
import type { ModelInfo, Provider, ProviderConfig, ThinkingLevel } from '../llm/types';
import { loadSettings, newProvider, saveSettings, type Settings } from '../store/settings';
import { deleteAllSongs, songCount } from '../store/songs';
import { h, injectStyle, isolateClicks, type Child } from './dom';
import css from './settings.css';

export interface OpenSettingsOptions {
  /** Welcome wording: the page opened this because no API key is set yet. */
  firstRun?: boolean;
  /** Called exactly once when the dialog goes away; `saved` is true only after 保存. */
  onClose?: (saved: boolean) => void;
}

/* ---------- small helpers ---------- */

let idSeq = 0;
const uid = (): string => `ll-f${(idSeq += 1)}`;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type StatusKind = '' | 'ok' | 'err' | 'busy';
interface Status { kind: StatusKind; text: string }
const NO_STATUS: Status = { kind: '', text: '' };

function paintStatus(el: HTMLElement, status: Status): void {
  el.textContent = status.text;
  el.className = status.kind ? `ll-status ll-status-${status.kind}` : 'll-status';
}

function describeError(error: unknown): string {
  if (error instanceof LLMError) return error.kind === 'auth' ? 'キーが無効か、権限がない' : (error.message || 'エラー').slice(0, 200);
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function isAborted(error: unknown): boolean {
  return error instanceof LLMError && error.kind === 'aborted';
}

/** The provider as it would be used right now (keys pasted with stray whitespace still work). */
function providerFor(config: ProviderConfig): Provider {
  return createProvider({ ...config, apiKey: config.apiKey.trim(), baseUrl: config.baseUrl.trim(), model: config.model.trim() });
}

/** Why a model-list request cannot even be attempted, or null when it can. */
function missingInput(config: ProviderConfig): string | null {
  const preset = presetFor(config.preset);
  if (preset.needsKey && !config.apiKey.trim()) return '先にキーを入力';
  if (config.kind === 'openai' && !(config.baseUrl.trim() || preset.baseUrl)) return 'ベース URL を入力';
  return null;
}

function modelText(model: ModelInfo): string {
  return model.label && model.label !== model.id ? `${model.label} · ${model.id}` : model.id;
}

function fillModelSelect(select: HTMLSelectElement, models: ModelInfo[], selected: string): void {
  const options: HTMLOptionElement[] = [h('option', { class: 'll-option', value: '' }, '自動（混雑時は別モデルへ切替）')];
  // A saved model that is not in the list (yet) must survive: a missing option would silently reset it to 自動.
  if (selected && !models.some((m) => m.id === selected)) options.push(h('option', { class: 'll-option', value: selected }, selected));
  for (const model of models) options.push(h('option', { class: 'll-option', value: model.id }, modelText(model)));
  select.replaceChildren(...options);
  select.value = selected;
}

function fillDatalist(list: HTMLDataListElement, models: ModelInfo[]): void {
  list.replaceChildren(...models.map((m) => h('option', { class: 'll-option', value: m.id }, m.label && m.label !== m.id ? m.label : null)));
}

function field(labelText: string, control: Node, forId?: string): HTMLElement {
  return h('div', { class: 'll-field' }, h('label', { class: 'll-label', htmlFor: forId }, labelText), control);
}

function link(text: string, href: string): HTMLAnchorElement {
  return h('a', { class: 'll-link', href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

function checkRow(text: string, checked: boolean, onChange: (value: boolean) => void, note?: string): HTMLElement {
  const box: HTMLInputElement = h('input', {
    class: 'll-checkbox',
    type: 'checkbox',
    checked,
    onChange: () => { onChange(box.checked); },
  });
  return h('label', { class: 'll-check' },
    box,
    h('span', { class: 'll-check-body' },
      h('span', { class: 'll-check-text' }, text),
      note ? h('span', { class: 'll-check-note' }, note) : null));
}

interface SecretField {
  wrap: HTMLElement;
  input: HTMLInputElement;
  id: string;
}

/** Password input with a 表示/隠す toggle. */
function secretField(value: string, onInput: (value: string) => void): SecretField {
  const id = uid();
  const input: HTMLInputElement = h('input', {
    class: 'll-input ll-key-input',
    id,
    type: 'password',
    value,
    placeholder: 'APIキーを貼り付け',
    // "new-password" keeps password managers from filling the site's own login into this field.
    autocomplete: 'new-password',
    spellcheck: false,
    autocapitalize: 'off',
    autocorrect: 'off',
    'data-lpignore': 'true',
    'data-1p-ignore': true,
    onInput: () => { onInput(input.value); },
  });
  const toggle: HTMLButtonElement = h('button', {
    class: 'll-btn ll-btn-small ll-toggle',
    type: 'button',
    'aria-pressed': 'false',
    'aria-label': 'キーを表示',
    onClick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? '隠す' : '表示';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', show ? 'キーを隠す' : 'キーを表示');
    },
  }, '表示');
  return { wrap: h('div', { class: 'll-inline' }, input, toggle), input, id };
}

function baseUrlField(config: ProviderConfig, preset: Preset): HTMLElement {
  const id = uid();
  const input: HTMLInputElement = h('input', {
    class: 'll-input',
    id,
    type: 'text',
    value: config.baseUrl,
    placeholder: preset.baseUrl || 'https://example.com/v1',
    autocomplete: 'off',
    spellcheck: false,
    inputmode: 'url',
    onInput: () => { config.baseUrl = input.value; },
  });
  return field('ベース URL', input, id);
}

/* ---------- modal ---------- */

interface Active { close(saved: boolean): void }
let active: Active | null = null;

export function closeSettings(): void {
  active?.close(false);
}

export function openSettings(options: OpenSettingsOptions = {}): void {
  closeSettings();
  injectStyle('ll-settings-style', css);
  mount(options);
}

interface RowState {
  models: ModelInfo[];
  status: Status;
  busy: boolean;
  ui: { status: HTMLElement; datalist: HTMLDataListElement; button: HTMLButtonElement } | null;
}

function mount(options: OpenSettingsOptions): void {
  const firstRun = Boolean(options.firstRun);
  const ac = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const pageRoot = document.documentElement;
  const previousOverflow = pageRoot.style.overflow;

  let current: Settings | null = null;
  let closed = false;
  let saving = false;
  let downOnBackdrop = false;

  const titleId = uid();
  const closeButton: HTMLButtonElement = h('button', {
    class: 'll-btn ll-close',
    type: 'button',
    'aria-label': '閉じる',
    title: '閉じる',
    onClick: () => { requestClose(); },
  }, '×');
  const body = h('div', { class: 'll-modal-body' }, h('p', { class: 'll-loading' }, '読み込み中…'));
  const footMessage = h('p', { class: 'll-foot-msg', role: 'status', 'aria-live': 'polite' });
  const cancelButton = h('button', { class: 'll-btn ll-btn-foot', type: 'button', onClick: () => { requestClose(); } }, 'キャンセル');
  const saveButton = h('button', { class: 'll-btn ll-btn-foot ll-btn-primary', type: 'button', disabled: true, onClick: () => { void save(); } }, '保存');

  const dialog = h('div', { class: 'll-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabIndex: -1 },
    h('div', { class: 'll-modal-head' },
      h('div', { class: 'll-modal-head-text' },
        h('h2', { class: 'll-modal-title', id: titleId }, firstRun ? 'Lyric Lens をはじめる' : 'Lyric Lens の設定'),
        firstRun ? h('p', { class: 'll-modal-lead' }, '無料の Gemini API キーを入れるだけで使える。') : null),
      closeButton),
    body,
    h('div', { class: 'll-modal-foot' }, footMessage, cancelButton, saveButton));

  const dark = pageRoot.classList.contains('ll-page-dark');
  const root = h('div', { class: `ll-root ll-modal${dark ? ' ll-dark' : ''}`, lang: 'ja' }, dialog);

  /* ----- lifecycle ----- */

  function later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
  }

  function finish(saved: boolean): void {
    if (closed) return;
    closed = true;
    ac.abort();
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    document.removeEventListener('keydown', onKeyDown, true);
    root.remove();
    pageRoot.style.overflow = previousOverflow;
    if (active === handle) active = null;
    if (previousFocus?.isConnected) {
      try { previousFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    try { options.onClose?.(saved); } catch (error) { console.error('[Lyric Lens] settings onClose failed', error); }
  }

  /** Close without saving, unless a save is in flight. */
  function requestClose(): void {
    if (!saving) finish(false);
  }

  const handle: Active = { close: (saved) => finish(saved) };

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    requestClose();
  }

  async function save(): Promise<void> {
    if (!current || saving || closed) return;
    saving = true;
    saveButton.disabled = true;
    cancelButton.disabled = true;
    footMessage.textContent = '';
    footMessage.className = 'll-foot-msg';
    const next: Settings = {
      ...current,
      providers: current.providers.map((p) => ({ ...p, apiKey: p.apiKey.trim(), baseUrl: p.baseUrl.trim(), model: p.model.trim() })),
    };
    try {
      await saveSettings(next);
    } catch (error) {
      saving = false;
      saveButton.disabled = false;
      cancelButton.disabled = false;
      footMessage.textContent = `保存できなかった: ${describeError(error)}`;
      footMessage.className = 'll-foot-msg ll-status-err';
      return;
    }
    saving = false;
    finish(true);
  }

  /* ----- contents ----- */

  function build(draft: Settings): { nodes: Node[]; mainKeyInput: HTMLInputElement | null } {
    const main = draft.providers[0]!;
    const rowStates = new Map<string, RowState>();
    const rowEls = new Map<string, HTMLElement>();

    const section = (title: string, ...children: Child[]): HTMLElement =>
      h('section', { class: 'll-section' }, h('h3', { class: 'll-section-title' }, title), ...children);

    /* -- main provider -- */

    const mainPreset = presetFor(main.preset);
    const mainModels: { list: ModelInfo[]; lazyFor: string } = { list: [], lazyFor: '' };
    let mainBusy = false;

    const mainStatus = h('p', { class: 'll-status', role: 'status', 'aria-live': 'polite' });
    const mainKey = secretField(main.apiKey, (value) => {
      main.apiKey = value;
      if (!mainBusy) paintStatus(mainStatus, NO_STATUS);
    });

    const modelSelect: HTMLSelectElement = h('select', {
      class: 'll-select',
      'aria-label': 'モデル',
      onChange: () => { main.model = modelSelect.value; },
      onFocus: () => { void loadModelsLazily(); },
    });
    fillModelSelect(modelSelect, [], main.model);

    const checkButton: HTMLButtonElement = h('button', {
      class: 'll-btn',
      type: 'button',
      onClick: () => { void checkConnection(); },
    }, '接続を確認');

    async function checkConnection(): Promise<void> {
      if (mainBusy) return;
      const missing = missingInput(main);
      if (missing) {
        paintStatus(mainStatus, { kind: 'err', text: missing });
        mainKey.input.focus();
        return;
      }
      const sentKey = main.apiKey;
      mainBusy = true;
      checkButton.disabled = true;
      paintStatus(mainStatus, { kind: 'busy', text: '確認中…' });
      try {
        const models = await modelsFor(providerFor(main), { refresh: true, signal: ac.signal });
        if (closed) return;
        mainModels.list = models;
        fillModelSelect(modelSelect, models, main.model);
        if (main.apiKey !== sentKey) paintStatus(mainStatus, NO_STATUS); // edited meanwhile: the result is about another key
        else if (models.length) paintStatus(mainStatus, { kind: 'ok', text: `OK · 使えるモデル ${models.length} 件` });
        else paintStatus(mainStatus, { kind: 'err', text: 'つながったが、使えるモデルが見つからない' });
      } catch (error) {
        if (closed || isAborted(error)) return;
        paintStatus(mainStatus, { kind: 'err', text: describeError(error) });
      } finally {
        mainBusy = false;
        checkButton.disabled = false;
      }
    }

    /** Fills the model list the first time the select is used (served from the cache when fresh). */
    async function loadModelsLazily(): Promise<void> {
      if (mainModels.list.length || mainBusy || missingInput(main)) return;
      const marker = `${main.apiKey.trim()}|${main.baseUrl.trim()}`;
      if (mainModels.lazyFor === marker) return; // already tried with this key
      mainModels.lazyFor = marker;
      try {
        const models = await modelsFor(providerFor(main), { signal: ac.signal });
        if (closed || mainModels.list.length) return;
        mainModels.list = models;
        fillModelSelect(modelSelect, models, main.model);
      } catch {
        /* silent: 接続を確認 shows the reason */
      }
    }

    const mainSection = section(
      'API キー（メイン）',
      h('p', { class: 'll-section-lead' }, mainPreset.label),
      field(mainPreset.needsKey ? 'API キー' : 'API キー（任意）', mainKey.wrap, mainKey.id),
      mainPreset.id === 'custom' || mainPreset.id === 'ollama' ? baseUrlField(main, mainPreset) : null,
      h('div', { class: 'll-actions' },
        checkButton,
        mainPreset.keyUrl ? link('キーを取得（無料）', mainPreset.keyUrl) : null),
      mainStatus,
      field('モデル', modelSelect),
      h('p', { class: 'll-note' }, 'キーはこのブラウザのユーザースクリプト用ストレージにだけ保存。歌詞と曲情報は選んだ API に送信される。'),
    );

    /* -- backups -- */

    const backupList = h('div', { class: 'll-prov-list' });
    const addButton = h('button', {
      class: 'll-btn ll-btn-add',
      type: 'button',
      onClick: () => {
        const added = newProvider('groq');
        draft.providers.push(added);
        renderBackups();
        const row = rowEls.get(added.id);
        row?.scrollIntoView({ block: 'nearest' });
        row?.querySelector<HTMLElement>('.ll-key-input')?.focus({ preventScroll: true });
      },
    }, '＋ 予備を追加');

    function stateOf(id: string): RowState {
      let state = rowStates.get(id);
      if (!state) {
        state = { models: [], status: NO_STATUS, busy: false, ui: null };
        rowStates.set(id, state);
      }
      return state;
    }

    function paintRow(state: RowState): void {
      const ui = state.ui;
      if (!ui) return;
      paintStatus(ui.status, state.status);
      ui.button.disabled = state.busy;
      fillDatalist(ui.datalist, state.models);
    }

    /** Rebuilds the rows, then focuses the first of `focus.selectors` that exists in row `focus.id`. */
    function renderBackups(focus?: { id: string; selectors: string[] }): void {
      rowEls.clear();
      const rows = draft.providers.slice(1).map((p) => buildRow(p));
      backupList.replaceChildren(...(rows.length ? rows : [h('p', { class: 'll-empty' }, '予備はまだない。')]));
      const row = focus ? rowEls.get(focus.id) : undefined;
      if (focus && row) {
        for (const selector of focus.selectors) {
          const target = row.querySelector<HTMLElement>(selector);
          if (target) { target.focus({ preventScroll: true }); break; }
        }
      }
    }

    function move(p: ProviderConfig, direction: -1 | 1): void {
      const from = draft.providers.indexOf(p);
      const to = from + direction;
      if (from < 1 || to < 1 || to >= draft.providers.length) return; // slot 0 is the main provider
      const other = draft.providers[to]!;
      draft.providers[to] = p;
      draft.providers[from] = other;
      const same = direction < 0 ? '.ll-move-up:not(:disabled)' : '.ll-move-down:not(:disabled)';
      const other2 = direction < 0 ? '.ll-move-down:not(:disabled)' : '.ll-move-up:not(:disabled)';
      renderBackups({ id: p.id, selectors: [same, other2] });
    }

    function buildRow(p: ProviderConfig): HTMLElement {
      const preset = presetFor(p.preset);
      const state = stateOf(p.id);
      const index = draft.providers.indexOf(p);

      const presetSelect: HTMLSelectElement = h('select', {
        class: 'll-select ll-prov-preset',
        'aria-label': 'サービス',
        onChange: () => {
          const at = draft.providers.indexOf(p);
          if (at < 1) return;
          // A key belongs to one service: never carry it over to another endpoint.
          draft.providers[at] = { ...newProvider(presetSelect.value), id: p.id, enabled: p.enabled };
          rowStates.delete(p.id);
          renderBackups({ id: p.id, selectors: ['.ll-prov-preset'] });
        },
      }, PRESETS.map((x) => h('option', { class: 'll-option', value: x.id }, x.label)));
      presetSelect.value = preset.id;

      const enabledBox: HTMLInputElement = h('input', {
        class: 'll-checkbox',
        type: 'checkbox',
        checked: p.enabled,
        onChange: () => {
          p.enabled = enabledBox.checked;
          row.classList.toggle('ll-off', !p.enabled);
        },
      });

      // Custom endpoints usually need a key too, so it is offered there even though the preset does not require one.
      const showKey = preset.needsKey || preset.id === 'custom';
      const keyField = showKey
        ? (() => {
          const secret = secretField(p.apiKey, (value) => {
            p.apiKey = value;
            if (!state.busy) { state.status = NO_STATUS; paintRow(state); }
          });
          return field(preset.needsKey ? 'API キー' : 'API キー（任意）', secret.wrap, secret.id);
        })()
        : null;

      const listId = uid();
      const modelId = uid();
      const datalist = h('datalist', { class: 'll-datalist', id: listId });
      const modelInput: HTMLInputElement = h('input', {
        class: 'll-input',
        id: modelId,
        type: 'text',
        value: p.model,
        placeholder: '自動',
        list: listId,
        autocomplete: 'off',
        spellcheck: false,
        autocapitalize: 'off',
        onInput: () => { p.model = modelInput.value; },
      });
      const listButton: HTMLButtonElement = h('button', {
        class: 'll-btn ll-btn-small ll-list-btn',
        type: 'button',
        onClick: () => { void fetchModels(); },
      }, '一覧を取得');
      const statusEl = h('p', { class: 'll-status', role: 'status', 'aria-live': 'polite' });
      state.ui = { status: statusEl, datalist, button: listButton };

      async function fetchModels(): Promise<void> {
        if (state.busy) return;
        const missing = missingInput(p);
        if (missing) {
          state.status = { kind: 'err', text: missing };
          paintRow(state);
          return;
        }
        state.busy = true;
        state.status = { kind: 'busy', text: '取得中…' };
        paintRow(state);
        try {
          const models = await modelsFor(providerFor(p), { refresh: true, signal: ac.signal });
          if (closed) return;
          if (!draft.providers.includes(p)) return; // row was removed or switched to another service meanwhile
          state.models = models;
          state.status = models.length
            ? { kind: 'ok', text: `使えるモデル ${models.length} 件` }
            : { kind: 'err', text: '使えるモデルが見つからない' };
        } catch (error) {
          if (closed || isAborted(error)) return;
          state.status = { kind: 'err', text: describeError(error) };
        } finally {
          state.busy = false;
          if (!closed) paintRow(state);
        }
      }

      paintRow(state);

      const last = index >= draft.providers.length - 1;
      const row: HTMLElement = h('div', { class: `ll-prov${p.enabled ? '' : ' ll-off'}` },
        h('div', { class: 'll-prov-head' },
          h('span', { class: 'll-prov-num', 'aria-hidden': 'true' }, String(index)),
          presetSelect,
          h('label', { class: 'll-check ll-check-inline' }, enabledBox, h('span', { class: 'll-check-text' }, '使う'))),
        keyField,
        preset.id === 'custom' || preset.id === 'ollama' ? baseUrlField(p, preset) : null,
        field('モデル（空欄で自動）',
          h('div', { class: 'll-inline' }, modelInput, listButton, datalist),
          modelId),
        statusEl,
        h('p', { class: 'll-hint' },
          preset.hint,
          preset.keyUrl ? ' ' : null,
          preset.keyUrl ? link('キーを取得', preset.keyUrl) : null),
        h('div', { class: 'll-prov-actions' },
          h('button', { class: 'll-btn ll-btn-small ll-move-up', type: 'button', disabled: index <= 1, 'aria-label': '上へ', title: '上へ', onClick: () => { move(p, -1); } }, '↑'),
          h('button', { class: 'll-btn ll-btn-small ll-move-down', type: 'button', disabled: last, 'aria-label': '下へ', title: '下へ', onClick: () => { move(p, 1); } }, '↓'),
          h('button', {
            class: 'll-btn ll-btn-small ll-btn-danger ll-remove',
            type: 'button',
            onClick: () => {
              const at = draft.providers.indexOf(p);
              if (at < 1) return;
              draft.providers.splice(at, 1);
              rowStates.delete(p.id);
              renderBackups();
              addButton.focus({ preventScroll: true });
            },
          }, '削除')));
      rowEls.set(p.id, row);
      return row;
    }

    renderBackups();

    const backupSection = section(
      '予備の API（任意）',
      h('p', { class: 'll-section-lead' }, 'メインが混雑・上限のとき、上から順に使う。'),
      backupList,
      h('div', { class: 'll-actions' }, addButton),
    );

    /* -- display -- */

    const displaySection = section(
      '表示',
      checkRow('歌詞の下に訳を表示', draft.showTranslation, (v) => { draft.showTranslation = v; }),
      checkRow('曲の要約カードを表示', draft.showSummary, (v) => { draft.showSummary = v; }),
      checkRow('曲を開いたら自動で訳す', draft.autoTranslate, (v) => { draft.autoTranslate = v; }, '開いた曲すべてで無料枠を使う'),
    );

    /* -- advanced -- */

    const thinkingId = uid();
    const thinkingSelect: HTMLSelectElement = h('select', {
      class: 'll-select',
      id: thinkingId,
      onChange: () => { draft.thinking = thinkingSelect.value as ThinkingLevel; },
    },
    h('option', { class: 'll-option', value: 'low' }, '低 · 速い'),
    h('option', { class: 'll-option', value: 'medium' }, '中 · おすすめ'),
    h('option', { class: 'll-option', value: 'high' }, '高 · 難しい曲向け'));
    thinkingSelect.value = draft.thinking;

    const advancedSection = h('details', { class: 'll-section ll-details' },
      h('summary', { class: 'll-summary' }, '詳細'),
      field('思考量', thinkingSelect, thinkingId));

    /* -- stored data -- */

    const countText = h('p', { class: 'll-data-count' }, '保存した曲: … 曲');
    const dataStatus = h('p', { class: 'll-status', role: 'status', 'aria-live': 'polite' });
    const flash = (status: Status): void => {
      paintStatus(dataStatus, status);
      later(() => paintStatus(dataStatus, NO_STATUS), 4000);
    };
    const refreshCount = (): void => {
      songCount().then(
        (n) => { if (!closed) countText.textContent = `保存した曲: ${n} 曲`; },
        () => { if (!closed) countText.textContent = '保存した曲: 不明'; },
      );
    };
    refreshCount();

    const deleteButton: HTMLButtonElement = h('button', {
      class: 'll-btn ll-btn-danger',
      type: 'button',
      onClick: () => {
        if (!window.confirm('保存した曲をすべて削除する？\nこの操作は元に戻せない。')) return;
        deleteButton.disabled = true;
        deleteAllSongs().then(
          () => { if (closed) return; flash({ kind: 'ok', text: '削除した' }); refreshCount(); },
          (error: unknown) => { if (!closed) flash({ kind: 'err', text: `削除できなかった: ${describeError(error)}` }); },
        ).finally(() => { deleteButton.disabled = false; });
      },
    }, 'すべて削除');
    const resetButton: HTMLButtonElement = h('button', {
      class: 'll-btn',
      type: 'button',
      onClick: () => {
        resetButton.disabled = true;
        clearCooldowns().then(
          () => { if (!closed) flash({ kind: 'ok', text: '記録をリセットした' }); },
          (error: unknown) => { if (!closed) flash({ kind: 'err', text: `リセットできなかった: ${describeError(error)}` }); },
        ).finally(() => { resetButton.disabled = false; });
      },
    }, '混雑・上限の記録をリセット');

    const dataSection = section(
      '保存データ',
      countText,
      h('div', { class: 'll-actions' }, deleteButton, resetButton),
      dataStatus,
    );

    return {
      nodes: [mainSection, backupSection, displaySection, advancedSection, dataSection],
      mainKeyInput: mainPreset.needsKey ? mainKey.input : null,
    };
  }

  /* ----- mount ----- */

  // The page's own handlers (annotation popovers, shortcuts) must not see anything that happens in here.
  isolateClicks(root);
  for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());
  // Only a press that both starts and ends on the backdrop closes it, so a text selection dragged out of an input does not.
  root.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === root; });
  root.addEventListener('click', (e) => {
    if (e.target === root && downOnBackdrop) requestClose();
    downOnBackdrop = false;
  });
  document.addEventListener('keydown', onKeyDown, true);

  (document.body ?? document.documentElement).appendChild(root);
  pageRoot.style.overflow = 'hidden';
  active = handle;
  closeButton.focus({ preventScroll: true });

  void (async () => {
    let loaded: Settings;
    try {
      loaded = await loadSettings();
    } catch (error) {
      if (!closed) body.replaceChildren(h('p', { class: 'll-status ll-status-err' }, `設定を読み込めなかった: ${describeError(error)}`));
      return;
    }
    if (closed) return;
    const draft = clone(loaded);
    if (!draft.providers.length) draft.providers.push(newProvider('gemini'));
    current = draft;
    const { nodes, mainKeyInput } = build(draft);
    body.replaceChildren(...nodes);
    saveButton.disabled = false;
    if (mainKeyInput && !draft.providers[0]!.apiKey.trim()) mainKeyInput.focus({ preventScroll: true });
    else closeButton.focus({ preventScroll: true });
  })();
}
