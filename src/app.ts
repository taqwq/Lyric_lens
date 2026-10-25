/*
 * Ties the page, the pipeline, storage and the UI together. Holds the only mutable state:
 * which song page is open, its stored result, and translation runs in flight (one per
 * song, kept running when the reader navigates away so the request is not wasted).
 */
import { translateSong } from './core/pipeline';
import { emptyRecord, songStatus } from './core/song';
import type { SongRecord } from './core/types';
import { fetchAnnotations } from './genius/annotations';
import { isOwnNode, readPage, type PageSong } from './genius/extract';
import { LLMError, isAbort } from './llm/errors';
import { currentSettings, hasAnyKey, loadSettings, onSettings, patchSettings } from './store/settings';
import { SaveQueue, deleteSong, loadSong, saveSong } from './store/songs';
import { renderCard } from './ui/card';
import { describeError } from './ui/describe';
import { Dock, toast, type DockAction, type DockView, type MenuItem } from './ui/dock';
import { InlineRenderer } from './ui/inline';
import { openSettings } from './ui/settings';

interface Run {
  path: string;
  record: SongRecord;
  /** Result being replaced by "訳し直す"; still shown (dimmed) and merged back on failure. */
  previous: SongRecord | null;
  controller: AbortController;
  status: string;
  saver: SaveQueue;
}

function mergeRecords(primary: SongRecord, fallback: SongRecord | null): SongRecord {
  if (!fallback) return primary;
  const merged: SongRecord = { ...primary, lines: { ...fallback.lines, ...primary.lines } };
  merged.context = primary.context?.about ? primary.context : fallback.context;
  return merged;
}

function hasLines(record: SongRecord | null | undefined): boolean {
  return Boolean(record && Object.keys(record.lines).length);
}

export class App {
  private page: PageSong | null = null;
  private record: SongRecord | null = null;
  private loadedPath = '';
  private readonly runs = new Map<string, Run>();
  private readonly errors = new Map<string, LLMError>();
  private panelOpen = false;
  private readonly inline = new InlineRenderer();
  private readonly dock = new Dock();
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;

  async start(): Promise<void> {
    await loadSettings();
    this.applyDisplay();
    onSettings(() => { this.applyDisplay(); this.scheduleRender(); });
    this.dock.mount();
    await this.refresh();
    this.watch();
  }

  /* ---------- page ---------- */

  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        const page = readPage();
        if (!page) {
          this.page = null;
          this.inline.clear();
          renderCard(null, null);
          this.renderDock();
          continue;
        }
        const pathChanged = page.path !== this.loadedPath;
        if (pathChanged) {
          this.loadedPath = page.path;
          this.panelOpen = false;
          const stored = this.runs.get(page.path)?.record ?? await loadSong(page.path);
          // Guard against a stale canonical URL after client-side navigation: never show
          // (or later overwrite) another song's translations.
          const title = page.source.meta.title;
          this.record = stored && stored.title && title && stored.title !== title ? null : stored;
        }
        this.page = page;
        this.detectTheme();
        this.renderNow();
        if (pathChanged) this.maybeAutoTranslate();
      } while (this.refreshAgain);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private scheduleRefresh(delay = 250): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.refresh(); }, delay);
  }

  private watch(): void {
    let href = location.href;
    setInterval(() => {
      if (location.href === href) return;
      href = location.href;
      this.scheduleRefresh(60);
    }, 700);
    window.addEventListener('popstate', () => this.scheduleRefresh(60));

    new MutationObserver((mutations) => {
      if (this.inline.damaged() || mutations.some((m) => this.affectsLyrics(m))) this.scheduleRefresh();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });

    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.code !== 'KeyT') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      this.toggleTranslation();
    });
  }

  private affectsLyrics(m: MutationRecord): boolean {
    const target = m.target.nodeType === 1 ? (m.target as Element) : m.target.parentElement;
    if (!target || target.closest('.ll-root, .ll-line, .ll-card')) return false;
    const nodes = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
    if (nodes.length && nodes.every((n) => isOwnNode(n))) return false;
    if (target.closest('[data-lyrics-container]')) return true;
    return nodes.some((n) => n.nodeType === 1 && (
      (n as Element).matches('[data-lyrics-container]') || Boolean((n as Element).querySelector('[data-lyrics-container]'))));
  }

  private detectTheme(): void {
    let el: Element | null = this.page?.containers[0] ?? null;
    let rgb: number[] | null = null;
    while (el) {
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor);
      const parts = m?.[1]?.split(',').map((x) => Number(x.trim()));
      if (parts && (parts[3] ?? 1) > 0.5) { rgb = parts; break; }
      el = el.parentElement;
    }
    const [r = 255, g = 255, b = 255] = rgb ?? [];
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    document.documentElement.classList.toggle('ll-page-dark', luminance < 0.4);
  }

  private applyDisplay(): void {
    const s = currentSettings();
    document.documentElement.classList.toggle('ll-hide-translation', !s.showTranslation);
    document.documentElement.classList.toggle('ll-hide-summary', !s.showSummary);
  }

  /* ---------- rendering ---------- */

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => { this.renderTimer = null; this.renderNow(); }, 60);
  }

  private renderNow(): void {
    const page = this.page;
    if (page) {
      const run = this.runs.get(page.path);
      const record = run?.record ?? this.record;
      this.inline.render({ page, record, fallback: run?.previous ?? null, running: Boolean(run) });
      renderCard(page, run ? mergeRecords(run.record, run.previous) : record);
    }
    this.renderDock();
  }

  private renderDock(): void {
    this.dock.update(this.dockView());
  }

  private dockView(): DockView {
    const page = this.page;
    const settings = currentSettings();
    const hidden: DockView = { visible: false, main: { label: '', tone: 'quiet', onClick: () => {} }, panel: null, menu: [] };
    if (!page) return hidden;

    const run = this.runs.get(page.path);
    const record = run?.record ?? this.record;
    const lines = page.source.lines;
    const total = lines.length;
    const done = lines.filter((l) => record?.lines[l.key]?.ja).length;
    const shown = done > 0 || hasLines(run?.previous);
    const status = songStatus(page.source, record);

    const menu: Array<MenuItem | 'sep'> = [];
    if (shown) menu.push({ label: settings.showTranslation ? '訳を隠す' : '訳を表示', hint: 'Alt+T', run: () => this.toggleTranslation() });
    if (record?.context?.about) menu.push({ label: settings.showSummary ? '「この曲について」を隠す' : '「この曲について」を表示', run: () => void patchSettings({ showSummary: !settings.showSummary }) });
    if (run) menu.push({ label: '中止する', run: () => this.cancel() });
    if (shown && !run) {
      menu.push({ label: 'この曲を訳し直す', run: () => void this.translate(true) });
      menu.push({ label: '保存した訳を削除', danger: true, run: () => void this.deleteCurrent() });
    }
    if (menu.length) menu.push('sep');
    menu.push({ label: '設定', run: () => this.openSettings(false) });

    if (run) {
      const waiting = done === 0;
      return {
        visible: true,
        main: {
          label: waiting ? '曲を読んでいます' : `訳しています ${done}/${total}`,
          tone: 'busy',
          progress: done / Math.max(1, total),
          onClick: () => { this.panelOpen = !this.panelOpen; this.renderDock(); },
        },
        panel: waiting || this.panelOpen ? {
          tone: 'info',
          title: waiting ? '曲全体を読んでから訳します' : `訳しています（${done}/${total}行）`,
          detail: waiting ? `${run.status}\n最初の行が届くまで十数秒かかることがある。` : run.status,
          actions: [{ label: '中止', run: () => this.cancel() }],
        } : null,
        menu,
      };
    }

    const error = this.errors.get(page.path);
    if (error && status.kind !== 'complete') {
      const text = describeError(error, done > 0);
      const actions: DockAction[] = [{ label: done > 0 ? '続きを訳す' : 'もう一度', primary: true, run: () => void this.translate() }];
      if (text.settings) actions.push({ label: '設定', run: () => this.openSettings(false) });
      actions.push({ label: '詳細をコピー', run: () => void this.copyError(error) });
      actions.push({ label: '閉じる', run: () => { this.errors.delete(page.path); this.renderDock(); } });
      return {
        visible: true,
        main: { label: done > 0 ? `続きを訳す · 残り${total - done}行` : 'もう一度試す', tone: 'error', onClick: () => void this.translate() },
        panel: { tone: 'error', title: text.title, detail: text.detail, actions },
        menu,
      };
    }

    if (status.kind === 'complete') {
      return {
        visible: true,
        main: { label: settings.showTranslation ? '訳を隠す' : '訳を表示', tone: 'quiet', title: 'Alt+T', onClick: () => this.toggleTranslation() },
        panel: null,
        menu,
      };
    }
    if (status.kind === 'partial') {
      return { visible: true, main: { label: `続きを訳す · 残り${total - done}行`, tone: 'accent', onClick: () => void this.translate() }, panel: null, menu };
    }
    return { visible: true, main: { label: '歌詞を訳す', tone: 'accent', onClick: () => void this.translate() }, panel: null, menu };
  }

  /* ---------- actions ---------- */

  async translate(force = false): Promise<void> {
    const page = this.page;
    if (!page || this.runs.has(page.path)) return;
    const settings = currentSettings();
    if (!hasAnyKey(settings)) {
      this.openSettings(true);
      return;
    }
    const { path, source } = page;
    const stored = this.record;
    const previous = force && hasLines(stored) ? stored : null;
    const record: SongRecord = force || !stored ? emptyRecord(path, source.meta) : structuredClone(stored);
    record.title = source.meta.title || record.title;
    record.artist = source.meta.artist || record.artist;

    const run: Run = { path, record, previous, controller: new AbortController(), status: '準備しています', saver: new SaveQueue() };
    this.runs.set(path, run);
    this.errors.delete(path);
    this.panelOpen = false;
    this.scheduleRender();

    try {
      // Community annotations sharpen slang/reference notes; skip them if Genius is slow.
      let input = source;
      if (page.songId) {
        run.status = 'Genius の注釈を集めています';
        this.scheduleRender();
        const annotations = await fetchAnnotations(page.songId);
        if (annotations.length) input = { ...source, meta: { ...source.meta, annotations } };
      }
      const outcome = await translateSong(input, record, {
        providers: settings.providers,
        thinking: settings.thinking,
        signal: run.controller.signal,
        onUpdate: () => {
          // Persist progress as it streams; a re-translation never leaves a half-empty song behind.
          run.saver.schedule(mergeRecords(record, previous));
          this.scheduleRender();
        },
        onStatus: (text) => { run.status = text; this.scheduleRender(); },
      });
      await run.saver.flush();
      await saveSong(record);
      if (!outcome.complete) this.errors.set(path, new LLMError('empty', '一部の行の訳を受け取れなかった。'));
      if (this.loadedPath !== path) toast(`「${record.title || '前の曲'}」を訳し終えた`);
    } catch (raw) {
      const error = raw instanceof LLMError ? raw : new LLMError('unknown', String(raw));
      if (!(raw instanceof LLMError)) console.error('[Lyric Lens]', raw);
      await run.saver.flush();
      const merged = mergeRecords(record, previous);
      Object.assign(record, merged);
      if (hasLines(record)) await saveSong(record);
      if (isAbort(error)) toast(hasLines(record) ? '中止した。途中までの訳は保存済み。' : '中止した。');
      else this.errors.set(path, error);
    } finally {
      this.runs.delete(path);
      if (this.loadedPath === path && hasLines(record)) this.record = record;
      this.scheduleRender();
    }
  }

  cancel(): void {
    const page = this.page;
    if (page) this.runs.get(page.path)?.controller.abort();
  }

  toggleTranslation(): void {
    const s = currentSettings();
    void patchSettings({ showTranslation: !s.showTranslation });
  }

  private async deleteCurrent(): Promise<void> {
    const page = this.page;
    if (!page || this.runs.has(page.path)) return;
    if (!confirm('この曲の保存した訳を削除する？')) return;
    await deleteSong(page.path);
    this.record = null;
    this.errors.delete(page.path);
    this.inline.clear();
    this.renderNow();
    toast('この曲の訳を削除した');
  }

  openSettings(firstRun: boolean): void {
    openSettings({
      firstRun,
      onClose: (saved) => {
        this.renderNow();
        if (saved && firstRun && hasAnyKey(currentSettings())) void this.translate();
      },
    });
  }

  private maybeAutoTranslate(): void {
    const page = this.page;
    const settings = currentSettings();
    if (!page || !settings.autoTranslate || !hasAnyKey(settings) || this.runs.has(page.path)) return;
    if (songStatus(page.source, this.record).kind === 'none') void this.translate();
  }

  private async copyError(error: LLMError): Promise<void> {
    const keys = currentSettings().providers.map((p) => p.apiKey.trim()).filter((k) => k.length > 6);
    let text = [
      `Lyric Lens ${__VERSION__}`,
      `kind=${error.kind} status=${error.status} provider=${error.provider} model=${error.model}`,
      `message=${error.message}`,
      error.detail ? `detail=${error.detail}` : '',
    ].filter(Boolean).join('\n');
    for (const key of keys) text = text.split(key).join('[REDACTED]');
    try {
      await navigator.clipboard.writeText(text);
      toast('エラーの詳細をコピーした');
    } catch {
      console.info('[Lyric Lens]', text);
      toast('コピーできなかった。コンソールに出力した');
    }
  }
}
