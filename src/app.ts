/*
 * The controller. Rendering is a pure function of (DOM lines, stored record, UI state);
 * the only side effects that cost quota happen in translate(), and only from a tap.
 * States follow docs/DESIGN.md §3 (S0–S8f).
 */
import { translateSong } from './core/pipeline';
import { emptyRecord, missingLines } from './core/song';
import type { GeniusAnnotation, SongRecord, StopInfo } from './core/types';
import { fetchAnnotations } from './genius/annotations';
import { isOwnNode, readPage, type PageSong } from './genius/extract';
import { availability, type Availability } from './llm/chain';
import { transportStreams } from './platform/http';
import { acquireLock, readLock, requestAbort, TAB_ID, type Lock, type LockHandle } from './store/lock';
import { currentSettings, hasAnyKey, loadSettings, onSettings, updateSettings } from './store/settings';
import { SaveQueue, deleteSong, loadSong, saveSong } from './store/songs';
import { HeadRow, type HeadAction, type HeadView } from './ui/head';
import { LineRenderer, type LinesInput, type SeamView } from './ui/lines';
import { NoteView } from './ui/notes';
import { openSheet } from './ui/sheet';
import { formatWhen } from './ui/time';

interface Run {
  id: string;
  title: string;
  /** The edition being written. For a retranslation it stays hidden until complete. */
  record: SongRecord;
  retranslate: boolean;
  controller: AbortController;
  saver: SaveQueue;
  lock: LockHandle;
}

type Kind = 'start' | 'resume' | 'retranslate';

function identityOf(page: PageSong): string {
  return page.songId ? `id:${page.songId}` : `path:${page.path}`;
}

function hasLines(record: SongRecord | null | undefined): boolean {
  return Boolean(record && Object.keys(record.lines).length);
}

export class App {
  private page: PageSong | null = null;
  private identity = '';
  private record: SongRecord | null = null;
  private run: Run | null = null;
  private foreignLock: Lock | null = null;
  private avail: Availability = { ok: true, until: 0 };
  private annotations: GeniusAnnotation[] | null = null;
  /** The record was already saved when this page opened: render without motion. */
  private fromCache = false;
  private prefaceCollapsed = false;
  private retranslateFailure: StopInfo | null = null;

  private readonly head = new HeadRow();
  private readonly lines = new LineRenderer();
  private readonly notes = new NoteView();
  private renderQueued = false;
  /** One-shot scroll reference for the next render (the control the reader just used). */
  private preferAnchor: Element | null = null;
  /** Set between the tap and the request start: a second tap must not send twice. */
  private starting = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;

  async start(): Promise<void> {
    await loadSettings();
    this.applyDisplay();
    onSettings(() => { this.applyDisplay(); this.scheduleRender(); });
    await this.refresh();
    this.watch();
  }

  /* ---------- page lifecycle ---------- */

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
          this.teardown();
          this.page = null;
          this.identity = '';
          continue;
        }
        const identity = identityOf(page);
        if (identity !== this.identity) {
          this.teardown();
          this.identity = identity;
          this.annotations = null;
          this.retranslateFailure = null;
          this.record = this.acceptStored(identity, page, await loadSong(identity));
          this.fromCache = hasLines(this.record);
          this.prefaceCollapsed = this.fromCache && !this.record?.stop;
        } else if (!this.run) {
          // Same song: pick up what other tabs wrote, or deletions made in settings.
          this.record = this.acceptStored(identity, page, await loadSong(identity));
        }
        this.page = page;
        this.foreignLock = await this.otherLock();
        this.avail = await availability(currentSettings().providers);
        this.detectTheme();
        this.renderNow();
      } while (this.refreshAgain);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Path identities can be stale after client-side navigation, so a title mismatch there
   *  means another song. A numeric Genius id is authoritative even if the song was renamed. */
  private acceptStored(identity: string, page: PageSong, stored: SongRecord | null): SongRecord | null {
    const title = page.source.meta.title;
    if (stored && identity.startsWith('path:') && stored.title && title && stored.title !== title) return null;
    return stored;
  }

  private teardown(): void {
    this.notes.close();
    this.lines.clear();
    this.head.clear();
  }

  private scheduleRefresh(delay = 200): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.refresh(); }, delay);
  }

  private watch(): void {
    let href = location.href;
    setInterval(() => {
      if (location.href !== href) {
        href = location.href;
        this.scheduleRefresh(60);
      }
    }, 700);
    window.addEventListener('popstate', () => this.scheduleRefresh(60));
    window.addEventListener('online', () => this.scheduleRender());
    window.addEventListener('offline', () => this.scheduleRender());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void loadSettings().then(() => this.refresh());
    });
    // Any interaction dismisses the transient "retranslation failed" line.
    document.addEventListener('pointerdown', () => {
      if (this.retranslateFailure) { this.retranslateFailure = null; this.scheduleRender(); }
    }, true);

    new MutationObserver((mutations) => {
      if (this.lines.damaged() || mutations.some((m) => this.affectsLyrics(m))) this.scheduleRefresh();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });

    // Another tab may start or finish a request: follow the shared lock (and, while another
    // tab writes this song, the record it saves).
    setInterval(() => void this.pollShared(), 1500);
  }

  private async pollShared(): Promise<void> {
    if (!this.page || document.visibilityState !== 'visible') return;
    const lock = await this.otherLock();
    const changed = JSON.stringify(lock) !== JSON.stringify(this.foreignLock);
    const mirroring = Boolean(lock && lock.id === this.identity) || Boolean(this.foreignLock && this.foreignLock.id === this.identity);
    this.foreignLock = lock;
    if (mirroring && !this.run) {
      const stored = await loadSong(this.identity);
      if (stored) this.record = stored;
    }
    if (changed && !lock) this.avail = await availability(currentSettings().providers);
    if (changed || mirroring) this.scheduleRender();
  }

  /** A lock held by another tab, or by this tab for another song. */
  private async otherLock(): Promise<Lock | null> {
    const lock = await readLock();
    if (!lock) return null;
    if (lock.tab === TAB_ID && this.run && lock.id === this.run.id && lock.id === this.identity) return null;
    return lock;
  }

  private affectsLyrics(m: MutationRecord): boolean {
    const target = m.target.nodeType === 1 ? (m.target as Element) : m.target.parentElement;
    if (!target || target.closest('.ll-head, .ll-line, .ll-note, .ll-sheet-host')) return false;
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
    document.documentElement.classList.toggle('ll-dark', (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.4);
  }

  private applyDisplay(): void {
    const hidden = currentSettings().hideTranslation;
    document.documentElement.classList.toggle('ll-hidden', hidden);
    if (hidden) this.notes.close();
  }

  /* ---------- rendering ---------- */

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    const run = () => { if (!this.renderQueued) return; this.renderQueued = false; this.renderNow(); };
    requestAnimationFrame(run);
    setTimeout(run, 120); // background tabs do not run animation frames
  }

  /** The edition on screen: a running (non-retranslation) record, else the stored one. */
  private shown(): SongRecord | null {
    const run = this.run;
    return run && run.id === this.identity && !run.retranslate ? run.record : this.record;
  }

  private renderNow(): void {
    const page = this.page;
    if (!page) return;
    this.syncNote(page);
    const { head, lines } = this.view(page);
    const prefer = this.preferAnchor;
    this.preferAnchor = null;
    this.anchored(() => {
      this.head.render(page, head);
      this.lines.render(lines);
      const open = this.notes.openIndex;
      if (open != null) this.notes.reattach(this.lines.nodeFor(open), page.texts[open]);
    }, prefer);
    this.scheduleWake();
  }

  /** An open note follows its line through re-renders, and closes or refreshes when the
   *  edition under it changes (retranslation swap, another tab's progress, lyric edits). */
  private syncNote(page: PageSong): void {
    const state = this.notes.state;
    if (!state) return;
    const index = page.source.lines[state.index]?.key === state.key ? state.index : page.source.lines.findIndex((l) => l.key === state.key);
    const result = this.shown()?.lines[state.key];
    const node = index >= 0 ? this.lines.nodeFor(index) : undefined;
    if (index < 0 || !node || !result?.notes?.length || this.retranslateFailure) {
      this.notes.close();
      return;
    }
    if (index !== state.index || JSON.stringify(result.notes) !== JSON.stringify(state.result.notes)) {
      this.notes.open({ index, key: state.key, lineNode: node, result, lineText: page.texts[index], annotations: this.annotations }, () => void this.toggleNote(index));
    }
  }

  /** Keeps a line still while nodes above it change height: by default the first English
   *  line in view, or `prefer` (what the reader just tapped) when it is on screen. */
  private anchored(change: () => void, prefer?: Element | null): void {
    const ref = prefer && prefer.isConnected && prefer.getBoundingClientRect().top >= 0 ? prefer : this.topVisibleAnchor();
    const before = ref ? this.topOf(ref) : null;
    const root = document.documentElement;
    const previous = root.style.overflowAnchor;
    root.style.overflowAnchor = 'none';
    change();
    if (ref && before != null && ref.isConnected) {
      const delta = this.topOf(ref) - before;
      if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
    }
    root.style.overflowAnchor = previous;
  }

  private topOf(node: Node): number {
    if (node.nodeType === 1) return (node as Element).getBoundingClientRect().top;
    const range = document.createRange();
    range.selectNode(node);
    return range.getBoundingClientRect().top;
  }

  private topVisibleAnchor(): Node | null {
    for (const anchor of this.page?.anchors ?? []) {
      if (!anchor.isConnected) continue;
      if (this.topOf(anchor) >= 0) return anchor;
    }
    return null;
  }

  /** Re-render when a disabled "続きを訳す" becomes possible again. */
  private scheduleWake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    const times = [this.record?.stop?.until, this.avail.ok ? 0 : this.avail.until].filter((t): t is number => Boolean(t && t > Date.now()));
    if (!times.length) return;
    const at = Math.min(...times);
    this.wakeTimer = setTimeout(() => {
      void availability(currentSettings().providers).then((a) => { this.avail = a; this.renderNow(); });
    }, Math.min(at - Date.now() + 500, 2 ** 31 - 1));
  }

  private view(page: PageSong): { head: HeadView; lines: LinesInput } {
    const settings = currentSettings();
    const run = this.run;
    const here = run && run.id === this.identity ? run : null;
    const shown = this.shown();
    const total = page.source.lines.length;
    const done = page.source.lines.filter((l) => shown?.lines[l.key]?.ja).length;
    const missing = total - done;
    const mirrored = !here && Boolean(this.foreignLock && this.foreignLock.id === this.identity);
    const otherSong = run && run.id !== this.identity ? run.title : this.foreignLock && this.foreignLock.id !== this.identity ? this.foreignLock.title : null;
    // What keeps a resume from being possible right now, said in the reader's terms.
    const quotaUntil = this.avail.ok ? null : this.avail.until;
    const blocker = otherSong
      ? '別の曲を訳し終えると続きを訳せます'
      : quotaUntil != null ? `今日の無料枠は終わりました · ${quotaUntil > Date.now() ? `${formatWhen(quotaUntil)}から訳せます` : 'あとで訳せます'}` : null;

    const settingsAction: HeadAction = { label: '設定', onClick: (b) => this.openSettings(b) };
    const hideAction: HeadAction = { label: settings.hideTranslation ? '訳を表示' : '訳を隠す', onClick: () => void this.toggleHidden() };
    const stopAction: HeadAction = { label: '止める', onClick: () => this.stop() };
    const preface = shown?.song && (shown.song.who || shown.song.what)
      ? {
        who: shown.song.who,
        what: shown.song.what,
        collapsed: this.prefaceCollapsed,
        onToggle: () => {
          this.prefaceCollapsed = !this.prefaceCollapsed;
          this.preferAnchor = this.head.element;
          this.renderNow();
        },
      }
      : null;
    const lines: LinesInput = {
      page, record: shown, slots: false, gaps: false, breathing: false, seam: null,
      animate: !this.fromCache, openIndex: this.notes.openIndex,
      onMark: (i) => void this.toggleNote(i),
      onMarkHover: (i, on) => this.peek(i, on),
    };

    // S8: retranslating — the old edition stays readable until the new one is complete.
    if (here?.retranslate) {
      return { head: { status: '訳し直しています · 終わるまで今の訳を表示します', actions: [stopAction], preface }, lines };
    }
    // S3 / S4: this tab is writing this song.
    if (here) {
      return {
        head: {
          status: preface ? '' : '曲全体を読んでいます',
          actions: preface ? [stopAction, hideAction, settingsAction] : [stopAction],
          note: transportStreams() ? undefined : 'この環境では訳がまとめて届きます',
          preface,
        },
        lines: { ...lines, slots: true, breathing: true },
      };
    }
    // S4m: another tab is writing this song; follow it from storage.
    if (mirrored) {
      return {
        head: { status: '別のタブで訳しています', actions: [{ label: '止める', onClick: () => void requestAbort() }, hideAction], preface },
        lines: { ...lines, slots: true, breathing: true },
      };
    }

    // S8f: a retranslation failed; the old edition is untouched.
    const failure = this.retranslateFailure;
    if (failure && done) {
      return {
        head: { status: '訳し直しは途中で止まりました。今の訳はそのままです', actions: [hideAction, settingsAction], note: this.seamText(failure), preface },
        lines,
      };
    }

    const stop = this.liveStop(shown?.stop);
    if (!done) {
      if (!hasAnyKey(settings)) {
        return { head: { status: '日本語訳には無料のAPIキーが必要です', actions: [{ label: 'キーを設定', primary: true, onClick: () => this.openFirstRun() }] }, lines };
      }
      if (otherSong) {
        return {
          head: { status: `別の曲（${otherSong}）を訳しています · 終わると訳せます`, actions: [{ label: 'あちらを止める', onClick: () => this.stopOther() }, settingsAction] },
          lines,
        };
      }
      if (quotaUntil != null) {
        return { head: { status: blocker ?? '', tone: 'muted', actions: [settingsAction] }, lines };
      }
      if (stop && stop.reason !== 'closed') {
        // Nothing arrived last time: say why here, with the same rule as a seam button.
        const seam = this.seamFor(stop, null);
        return { head: { status: seam.text, actions: [{ ...seam.button, label: seam.button.label === '続きを訳す' ? '日本語で読む' : seam.button.label, primary: true }, settingsAction] }, lines };
      }
      return { head: { status: '', actions: [{ label: '日本語で読む', primary: true, onClick: () => void this.translate('start') }, settingsAction] }, lines };
    }

    // S5: complete.
    if (!missing) {
      return { head: { status: '', actions: [hideAction, settingsAction], preface }, lines };
    }
    const resume: HeadAction = { label: '訳す', primary: true, disabled: Boolean(blocker), onClick: () => void this.translate('resume') };
    // S5g: the model skipped some lines.
    if (stop?.reason === 'gaps') {
      return {
        head: { status: `${missing}行が訳せていません`, actions: [resume, hideAction, settingsAction], note: blocker ?? undefined, preface },
        lines: { ...lines, gaps: true },
      };
    }
    // S7: Genius changed the lyrics since the edition was finished.
    if (!stop) {
      return {
        head: { status: `歌詞が更新され、まだ訳していない行が${missing}行あります`, actions: [resume, hideAction, settingsAction], note: blocker ?? undefined, preface },
        lines: { ...lines, slots: true },
      };
    }
    // S6: interrupted; the seam sits at the first empty slot.
    const seam = this.seamFor(stop, blocker);
    return {
      head: { status: `途中まで訳してあります（${done}/${total}行）`, actions: [{ ...seam.button, primary: true }, hideAction, settingsAction], preface },
      lines: { ...lines, slots: true, seam },
    };
  }

  /** A stored stop whose wait is over reads as plain "ここまで訳してあります". */
  private liveStop(stop: StopInfo | undefined): StopInfo | undefined {
    if (!stop) return stop;
    if ((stop.reason === 'quota' || stop.reason === 'rate') && stop.until && stop.until <= Date.now()) return { reason: 'closed', at: stop.at };
    return stop;
  }

  private seamText(stop: StopInfo): string {
    const when = stop.until && stop.until > Date.now() ? formatWhen(stop.until) : '';
    const text: Record<StopInfo['reason'], string> = {
      busy: '混み合っていて、ここで途切れました',
      rate: '短い時間に使いすぎました。1分ほどおいてから続きを訳せます',
      quota: `今日の無料枠が終わりました。${when ? `${when}ごろから` : 'あとで'}続きを訳せます`,
      auth: 'APIキーが使えません。設定で確かめてください',
      blocked: 'この先はAIの安全フィルタで止められました。別のモデルなら通ることがあります',
      network: '接続が切れました。つながったら続きを訳せます',
      unusable: 'うまく受け取れない返事が来ました',
      stopped: 'ここで止めました',
      length: '長い曲なので、ここで一度区切りました',
      closed: 'ここまで訳してあります',
      gaps: 'ここまで訳してあります',
    };
    return text[stop.reason];
  }

  /** The seam's sentence and button. `blocker` (another song running, quota spent) disables
   *  the button and is said right there, so a tap never silently does nothing. */
  private seamFor(stop: StopInfo, blocker: string | null): SeamView {
    const now = Date.now();
    const text = this.seamText(stop);
    if (stop.reason === 'auth') return { text, button: { label: '設定を開く', onClick: () => this.openSettings(null) } };
    let disabled = false;
    if (stop.reason === 'rate' && stop.until && now < stop.until) disabled = true;
    if (stop.reason === 'network' && !navigator.onLine) disabled = true;
    if (blocker && stop.reason !== 'quota') return { text: `${text}。${blocker}`, button: { label: '続きを訳す', disabled: true, onClick: () => {} } };
    if (blocker) disabled = true;
    return { text, button: { label: '続きを訳す', disabled, onClick: () => void this.translate('resume') } };
  }

  /* ---------- notes ---------- */

  private async toggleNote(index: number): Promise<void> {
    const page = this.page;
    if (!page) return;
    const markOf = (i: number) => this.lines.nodeFor(i)?.querySelector<HTMLElement>('.ll-mark') ?? null;
    if (this.notes.openIndex === index) {
      this.anchored(() => this.notes.close(), this.lines.nodeFor(index));
      this.renderNow();
      markOf(index)?.focus();
      return;
    }
    const line = page.source.lines[index];
    const result = line && this.shown()?.lines[line.key];
    const node = this.lines.nodeFor(index);
    if (!line || !result?.notes?.length || !node) return;
    const open = () => this.anchored(() => this.notes.open(
      { index, key: line.key, lineNode: node, result, lineText: page.texts[index], annotations: this.annotations },
      () => void this.toggleNote(index),
    ), node);
    open();
    this.renderNow();
    markOf(index)?.focus();
    if (this.annotations === null && page.songId) {
      this.annotations = await fetchAnnotations(page.songId);
      if (this.notes.openIndex === index && this.annotations.length) open();
    }
  }

  private peek(index: number, on: boolean): void {
    const page = this.page;
    const line = page?.source.lines[index];
    const notes = line ? this.shown()?.lines[line.key]?.notes : undefined;
    this.notes.peek(page?.texts[index], on && notes ? notes : null);
  }

  /* ---------- actions ---------- */

  async translate(kind: Kind): Promise<void> {
    const page = this.page;
    // A button locks the moment it is pressed: a second tap during the awaits below must
    // not send a second request.
    if (!page || this.run || this.starting) return;
    this.starting = true;
    let lock: LockHandle | null = null;
    let run: Run | null = null;
    try {
      const settings = await loadSettings();
      if (!hasAnyKey(settings)) {
        this.openFirstRun();
        return;
      }
      this.avail = await availability(settings.providers);
      if (!this.avail.ok) {
        this.renderNow();
        return;
      }
      const id = this.identity;
      const { source } = page;
      lock = await acquireLock(id, source.meta.title || '前の曲');
      if (!lock) {
        this.foreignLock = await this.otherLock();
        this.renderNow();
        return;
      }
      // Start from what storage has now: another tab may have finished this song while
      // this one sat in the background.
      const stored = this.acceptStored(id, page, await loadSong(id));
      if (stored) this.record = stored;
      const retranslate = kind === 'retranslate' && hasLines(stored);
      if (!retranslate && stored && !missingLines(source, stored).length) {
        await lock.release();
        lock = null;
        this.renderNow();
        return;
      }
      const record: SongRecord = retranslate || !stored ? emptyRecord(id, page.path, source.meta) : structuredClone(stored);
      record.title = source.meta.title || record.title;
      record.artist = source.meta.artist || record.artist;
      // Saved progress says "closed" until the request ends, so a tab that dies mid-stream
      // leaves a resumable song rather than one that looks finished.
      record.stop = { reason: 'closed', at: Date.now() };

      run = { id, title: record.title, record, retranslate, controller: new AbortController(), saver: new SaveQueue(), lock };
      this.run = run;
      this.starting = false;
      this.fromCache = false;
      this.retranslateFailure = null;
      this.prefaceCollapsed = false;
      // Asking for Japanese means wanting to see it.
      if (settings.hideTranslation) await updateSettings((s) => ({ ...s, hideTranslation: false }));
      const current = run;
      current.lock.start(() => current.controller.abort());
      // A reload or closed tab should not leave a live-looking lock for 10 s.
      const bye = () => { current.controller.abort(); void current.lock.release(); };
      window.addEventListener('pagehide', bye, { once: true });
      this.renderNow();

      try {
        if (page.songId && this.annotations === null) this.annotations = await fetchAnnotations(page.songId);
        const input = this.annotations?.length ? { ...source, meta: { ...source.meta, annotations: this.annotations } } : source;
        const outcome = await translateSong(input, record, {
          providers: settings.providers,
          thinking: settings.thinking,
          signal: current.controller.signal,
          onUpdate: () => {
            if (!retranslate) current.saver.schedule(record);
            this.scheduleRender();
          },
        });
        if (retranslate) {
          if (outcome.complete) {
            await saveSong(record);
            if (this.identity === id) {
              this.record = record;
              this.notes.close();
            }
          } else if (this.identity === id) {
            this.retranslateFailure = outcome.stop ?? { reason: 'unusable', at: Date.now() };
          }
        } else {
          await current.saver.flush();
          await saveSong(record);
          if (this.identity === id) this.record = record;
        }
      } catch (error) {
        console.error('[Lyric Lens]', error);
        if (!retranslate) {
          record.stop = { reason: 'unusable', at: Date.now() };
          await current.saver.flush();
          if (hasLines(record)) await saveSong(record);
          if (this.identity === id) this.record = record;
        }
      } finally {
        window.removeEventListener('pagehide', bye);
      }
    } finally {
      this.starting = false;
      if (lock) await lock.release();
      if (run) {
        this.run = null;
        this.foreignLock = await this.otherLock();
        this.avail = await availability(currentSettings().providers);
        this.renderNow();
      }
    }
  }

  stop(): void {
    this.run?.controller.abort();
  }

  private stopOther(): void {
    if (this.run && this.run.id !== this.identity) this.run.controller.abort();
    else void requestAbort();
  }

  private async toggleHidden(): Promise<void> {
    await updateSettings((s) => ({ ...s, hideTranslation: !s.hideTranslation }));
    this.renderNow();
  }

  /** After the reader changed keys, an "invalid key" stop no longer applies: let the song
   *  offer 続きを訳す / 日本語で読む again. */
  private async afterSheet(changed: boolean): Promise<void> {
    await loadSettings();
    const record = this.record;
    if (changed && !this.run && record?.stop?.reason === 'auth') {
      if (hasLines(record)) record.stop = { reason: 'closed', at: Date.now() };
      else delete record.stop;
      await saveSong(record);
    }
    await this.refresh();
  }

  openSettings(anchor: HTMLElement | null): void {
    const record = this.record;
    openSheet({
      mode: 'settings',
      anchor,
      song: this.page && hasLines(record) ? { title: record!.title, model: record!.model, translatedAt: record!.updatedAt } : null,
      onRetranslate: () => void this.translate('retranslate'),
      onDeleteSong: async () => {
        if (!record) return;
        await deleteSong(record.id);
        this.notes.close();
        this.record = null;
        this.renderNow();
      },
      onClose: (changed) => void this.afterSheet(changed),
    });
  }

  private openFirstRun(): void {
    openSheet({
      mode: 'first-run',
      onSaveAndTranslate: () => void this.translate('start'),
      onClose: (changed) => void this.afterSheet(changed),
    });
  }
}
