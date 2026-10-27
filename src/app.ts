/*
 * The controller. Rendering is a pure function of (DOM lines, stored record, UI state);
 * the only side effects that cost quota happen in translate(), and only from a tap.
 * States follow docs/DESIGN.md §3 (S0–S8f).
 */
import { translateSong } from './core/pipeline';
import { emptyRecord, isMostlyJapanese, missingLines } from './core/song';
import type { GeniusAnnotation, SongRecord } from './core/types';
import { fetchAnnotations } from './genius/annotations';
import { isOwnNode, readPage, type PageSong } from './genius/extract';
import { availability, cleanOtherProviders, keyStatus, type Availability } from './llm/chain';
import { transportStreams } from './platform/http';
import { acquireLock, readLock, requestAbort, TAB_ID, type Lock, type LockHandle } from './store/lock';
import { currentSettings, hasKey, loadSettings, onSettings } from './store/settings';
import { SaveQueue, deleteSong, loadSong, saveSong, setSongHidden, touchSong } from './store/songs';
import { HeadRow, type HeadAction, type HeadView } from './ui/head';
import { LineRenderer, type LinesInput, type SeamView } from './ui/lines';
import { NoteView } from './ui/notes';
import { closeSheet, openSheet } from './ui/sheet';
import { decide, failureText, type ActionId, type ActionSpec, type ViewInput } from './ui/state';
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
  startedAt: number;
}

type Kind = 'start' | 'resume' | 'retranslate';

function identityOf(page: PageSong): string {
  return page.songId ? `id:${page.songId}` : `path:${page.path}`;
}

function hasLines(record: SongRecord | null | undefined): boolean {
  return Boolean(record && Object.keys(record.lines).length);
}

/** viewInput runs on every render; the language of a page's lyrics does not change. */
const japaneseCache = new WeakMap<PageSong['source'], boolean>();
function isJapanese(page: PageSong): boolean {
  let known = japaneseCache.get(page.source);
  if (known === undefined) {
    known = isMostlyJapanese(page.source);
    japaneseCache.set(page.source, known);
  }
  return known;
}

/** Genius' lyric font list without its generic fallbacks: a trailing `sans-serif` would make
 *  the browser draw our Japanese with its default face before reaching our Japanese stack. */
export function latinFamilies(family: string): string {
  const GENERIC = /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|math|emoji|fangsong|-apple-system|blinkmacsystemfont)$/i;
  return family.split(',').map((f) => f.trim()).filter((f) => f && !GENERIC.test(f.replace(/^["']|["']$/g, ''))).join(', ');
}

/** Head-row notice when the finished edition could not be stored. */
const SAVE_FAILED = { status: '保存できませんでした', detail: 'この画面では読めますが、ページを閉じると消えます' };

export class App {
  private page: PageSong | null = null;
  private identity = '';
  private record: SongRecord | null = null;
  private run: Run | null = null;
  private foreignLock: Lock | null = null;
  private avail: Availability = { ok: true, until: 0 };
  /** Some configured key is known to be rejected: an invalid-key stop still applies. */
  private keyBad = false;
  private annotations: GeniusAnnotation[] | null = null;
  /** The record was already saved when this page opened: render without motion. */
  private fromCache = false;
  private prefaceCollapsed = false;
  /** Transient head-row message (S8f, or a retranslation that could not start). Any
   *  pointer or key interaction dismisses it. */
  private notice: { status: string; detail: string } | null = null;
  /** The edition on screen could not be stored: storage must not replace it until it is. */
  private unsaved = false;
  /** A request ran here for this song since it was opened: reaching S5 then settles the head once. */
  private wrote = false;
  /** The reader just tapped a button that creates the empty slots: the next render that
   *  shows them unfolds the ones near the viewport (LinesInput.opening). */
  private opening = false;

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
    const settings = await loadSettings();
    this.applyDisplay();
    onSettings(() => { this.applyDisplay(); this.scheduleRender(); });
    await this.refresh();
    this.watch();
    // Housekeeping (a scan of every stored key) must not hold up the first paint of a saved translation.
    void cleanOtherProviders(settings.apiKey).catch(() => {});
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
        const fresh = identity !== this.identity;
        if (fresh) {
          this.teardown();
          this.identity = identity;
          this.annotations = null;
          this.notice = null;
          this.unsaved = false;
          this.wrote = false;
          this.opening = false;
          this.record = this.acceptStored(identity, page, await loadSong(identity));
          this.fromCache = hasLines(this.record);
          this.prefaceCollapsed = this.fromCache && !this.record?.stop;
          // Reading a saved edition counts as use: LRU keeps what the reader returns to.
          if (this.fromCache) void touchSong(identity);
        } else if (!this.run && !this.unsaved) {
          // Same song: pick up what other tabs wrote, or deletions made in settings.
          // (Not while the edition on screen exists only here: that would erase it.)
          this.record = this.acceptStored(identity, page, await loadSong(identity));
        }
        this.page = page;
        this.foreignLock = await this.otherLock();
        await this.refreshKeys();
        this.detectTheme();
        this.followLyricFont(page);
        this.renderNow();
        // Genius' own annotations API is free and same-origin (not an LLM request): fetch
        // once so the grounding is ready before the tap and opened notes do not grow later.
        if (fresh && page.songId && (hasKey(currentSettings()) || this.fromCache)) this.prefetchAnnotations(page);
      } while (this.refreshAgain);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Path identities can be stale after client-side navigation, so a title mismatch there
   *  means another song. A numeric Genius id is authoritative even if the song was renamed. */
  private acceptStored(identity: string, page: PageSong, stored: SongRecord | null): SongRecord | null {
    const title = page.source.meta.title;
    if (stored && identity.startsWith('path:') && stored.title && title && stored.title !== title) return null;
    // A first request that produced nothing leaves no edition behind (an invalid key is
    // the exception: it explains why 日本語で読む needs a new key first).
    if (stored && !hasLines(stored) && stored.stop?.reason !== 'auth') return null;
    return stored;
  }

  private prefetchAnnotations(page: PageSong): void {
    if (this.page?.songId === page.songId) void this.loadAnnotations(page);
  }

  private teardown(): void {
    closeSheet();
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
      if (document.visibilityState !== 'visible') return;
      // Another tab may have changed 訳を隠す: apply it before the label is rebuilt from it.
      void loadSettings().then(() => {
        this.anchored(() => this.applyDisplay());
        return this.refresh();
      });
    });
    // Any interaction dismisses the transient notice (S8f).
    // ...but only while the head row is on screen: the gesture made elsewhere is often the
    // scroll back up to it, which must not erase the notice unseen.
    const dismiss = () => {
      if (!this.notice) return;
      const r = this.head.element?.getBoundingClientRect();
      if (!r || r.bottom <= 0 || r.top >= window.innerHeight) return;
      this.notice = null;
      this.scheduleRender();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', dismiss, true);

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
    if (changed && !lock) await this.refreshKeys();
    if (changed || mirroring) this.scheduleRender();
  }

  /** What the configured keys allow right now, from what is already known (no request). */
  private async refreshKeys(): Promise<void> {
    const { apiKey } = currentSettings();
    this.avail = await availability(apiKey);
    // An invalid-key stop applies only while the key is not believed to work.
    this.keyBad = !apiKey.trim() || (await keyStatus(apiKey)).kind === 'bad';
  }

  /** A lock held by another tab. */
  private async otherLock(): Promise<Lock | null> {
    // This tab's own request (for any song) is this.run; its lock is never "another tab",
    // even in the moment between acquiring it and setting this.run.
    const lock = await readLock();
    return lock && lock.tab !== TAB_ID ? lock : null;
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

  /** 訳を隠す is per song: it follows the record of the song on screen. */
  private applyDisplay(): void {
    const hidden = Boolean(this.shown()?.hidden);
    document.documentElement.classList.toggle('ll-hidden', hidden);
    if (hidden) this.notes.close();
  }

  /** Latin text in a translated line is set in the lyrics' own face (--ll-latin). */
  private followLyricFont(page: PageSong): void {
    try {
      const family = latinFamilies(getComputedStyle(page.containers[0]!).fontFamily);
      if (family) document.documentElement.style.setProperty('--ll-latin', family);
    } catch { /* no container yet: the stylesheet's fallback applies */ }
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
    const prefer = this.preferAnchor;
    this.preferAnchor = null;
    const focusedHere = this.focusInsideOurUi();
    this.anchored(() => {
      this.applyDisplay();
      // Closing or refreshing a note above the viewport is compensated like everything else.
      this.syncNote(page);
      const { head, lines } = this.view(page);
      this.head.render(page, head);
      this.lines.render(lines);
      this.syncNote(page);
    }, prefer);
    // A rebuilt control must not drop keyboard focus to <body>.
    if (focusedHere && !this.focusInsideOurUi()) this.head.focusFirst();
    this.scheduleWake();
  }

  private focusInsideOurUi(): boolean {
    const active = document.activeElement;
    return Boolean(active && active !== document.body && active.closest?.('.ll-head, .ll-line, .ll-note'));
  }

  /** An open note follows its line through re-renders, and closes or refreshes when the
   *  edition under it changes (retranslation swap, another tab's progress, lyric edits,
   *  Genius annotations arriving, Genius re-rendering the text under it). */
  private syncNote(page: PageSong): void {
    const state = this.notes.state;
    if (!state) return;
    const index = page.source.lines[state.index]?.key === state.key ? state.index : page.source.lines.findIndex((l) => l.key === state.key);
    const result = this.shown()?.lines[state.key];
    const node = index >= 0 ? this.lines.nodeFor(index) : undefined;
    if (index < 0 || !node || !result?.notes?.length) {
      this.notes.close();
      return;
    }
    const changed = index !== state.index || JSON.stringify(result.notes) !== JSON.stringify(state.result.notes)
      || state.annotations !== this.annotations || state.lineText !== page.texts[index];
    if (changed) {
      this.notes.open({ index, key: state.key, lineNode: node, result, lineText: page.texts[index], annotations: this.annotations }, () => void this.toggleNote(index));
    } else if (node.nextSibling !== this.notes.element) {
      this.notes.reattach(node, page.texts[index]);
    }
  }

  /** Keeps a line still while nodes above it change height: by default the first English
   *  line in view, or `prefer` (what the reader just tapped) when it is on screen. */
  private anchored(change: () => void, prefer?: Element | null): void {
    const inView = (top: number) => top >= 0 && top < window.innerHeight;
    // What to hold still: the control just used, else the first lyric line in view. If the
    // lyrics are entirely below the viewport nothing above the reader changes; if they are
    // entirely above it (reading comments), hold the end of the lyrics instead.
    let measure: (() => number) | null = null;
    if (prefer?.isConnected && inView(prefer.getBoundingClientRect().top)) {
      measure = () => prefer.getBoundingClientRect().top;
    } else {
      const anchor = this.firstAnchorBelowTop();
      if (anchor === 'none') {
        const last = this.page?.containers.at(-1);
        if (last?.isConnected) measure = () => last.getBoundingClientRect().bottom;
      } else if (anchor && inView(this.topOf(anchor))) {
        measure = () => this.topOf(anchor);
      }
    }
    const before = measure?.() ?? null;
    const root = document.documentElement;
    const previous = root.style.overflowAnchor;
    root.style.overflowAnchor = 'none';
    change();
    if (measure && before != null) {
      const delta = measure() - before;
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

  /** The first lyric anchor at or below the viewport top, or 'none' if all are above it. */
  private firstAnchorBelowTop(): Node | 'none' | null {
    let any = false;
    for (const anchor of this.page?.anchors ?? []) {
      if (!anchor.isConnected) continue;
      any = true;
      if (this.topOf(anchor) >= 0) return anchor;
    }
    return any ? 'none' : null;
  }

  /** Re-render when a disabled "続きを訳す" becomes possible again. */
  private scheduleWake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    const times = [this.record?.stop?.until, this.avail.ok ? 0 : this.avail.until].filter((t): t is number => Boolean(t && t > Date.now()));
    if (!times.length) return;
    const at = Math.min(...times);
    this.wakeTimer = setTimeout(() => {
      void this.refreshKeys().then(() => this.renderNow());
    }, Math.min(at - Date.now() + 500, 2 ** 31 - 1));
  }

  /** Everything the pure state machine (ui/state.ts) needs, read from this tab's state. */
  private viewInput(page: PageSong): ViewInput {
    const settings = currentSettings();
    const run = this.run;
    const here = run && run.id === this.identity ? run : null;
    const shown = this.shown();
    return {
      now: Date.now(),
      online: navigator.onLine,
      streams: transportStreams(),
      waitedMs: here ? Date.now() - here.startedAt : undefined,
      hidden: Boolean(shown?.hidden),
      hasKey: hasKey(settings),
      keyBad: this.keyBad,
      total: page.source.lines.length,
      done: page.source.lines.filter((l) => shown?.lines[l.key]?.ja).length,
      stop: shown?.stop,
      hasPreface: Boolean(shown?.song && (shown.song.who || shown.song.what)),
      japanese: isJapanese(page),
      running: here ? (here.retranslate ? 'here-retranslate' : 'here') : 'none',
      mirrored: !here && Boolean(this.foreignLock && this.foreignLock.id === this.identity),
      otherSong: run && run.id !== this.identity ? run.title : this.foreignLock && this.foreignLock.id !== this.identity ? this.foreignLock.title : null,
      avail: this.avail,
      notice: this.notice,
    };
  }

  private view(page: PageSong): { head: HeadView; lines: LinesInput } {
    const input = this.viewInput(page);
    const d = decide(input);
    const shown = this.shown();
    const bind = (a: ActionSpec): HeadAction => ({ ...a, onClick: (el) => this.act(a.id, el, input) });
    const preface = d.preface && shown?.song
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
    const seam: SeamView | null = d.lines.seam
      ? { text: d.lines.seam.text, button: { ...d.lines.seam.button, onClick: () => this.act(d.lines.seam!.button.id, null, input) } }
      : null;
    if (input.running !== 'none') this.wrote = true;
    // A run in this session reached S5: the head settles once.
    const settle = d.state === 'S5' && this.wrote;
    if (settle) this.wrote = false;
    // The first render that shows the slots a tap just created.
    const opening = this.opening && input.running === 'here';
    if (opening) this.opening = false;
    return {
      head: {
        state: d.state, tone: d.tone, status: d.status,
        ...(d.count ? { count: `（${d.count.done}/${d.count.total}行）` } : {}),
        progress: d.progress,
        ...(settle ? { settle: true } : {}),
        captions: d.captions, actions: d.actions.map(bind), preface,
      },
      lines: {
        page, record: shown, slots: d.lines.slots, gaps: d.lines.gaps, breathing: d.lines.breathing, seam,
        animate: !this.fromCache, ...(opening ? { opening: true } : {}), openIndex: this.notes.openIndex,
        onMark: (i) => void this.toggleNote(i),
        onMarkHover: (i, on) => this.peek(i, on),
      },
    };
  }

  /** Runs an action named by the state machine. */
  private act(id: ActionId, el: HTMLElement | null, input: ViewInput): void {
    switch (id) {
      case 'start': this.opening = true; void this.translate('start').catch((e) => console.error('[Lyric Lens]', e)); break;
      case 'resume': this.opening = true; void this.translate('resume').catch((e) => console.error('[Lyric Lens]', e)); break;
      case 'stop': this.stop(); break;
      case 'stopMirror': void requestAbort(); break;
      case 'stopOther': this.stopOther(); break;
      case 'hide': void this.toggleHidden(); break;
      case 'settings': this.openSettings(el); break;
      case 'firstRun': this.openFirstRun(); break;
      case 'noop': break;
    }
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
    this.anchored(() => this.notes.open(
      { index, key: line.key, lineNode: node, result, lineText: page.texts[index], annotations: this.annotations },
      () => void this.toggleNote(index),
      true,
    ), node);
    this.renderNow();
    markOf(index)?.focus();
    await this.loadAnnotations(page);
  }

  /** Genius annotations for the open song, fetched once; a result that arrives after the
   *  reader moved to another song is dropped. syncNote re-renders an open note with them. */
  private async loadAnnotations(page: PageSong): Promise<GeniusAnnotation[]> {
    const songId = page.songId;
    if (!songId) return [];
    // An empty list is not cached here: a failed fetch (timeout, 403) also returns [] and
    // must be retried; fetchAnnotations itself remembers songs Genius answered for.
    if (this.annotations?.length) return this.annotations;
    const list = await fetchAnnotations(songId);
    if (this.page?.songId !== songId) return list;
    if (list.length) {
      this.annotations = list;
      if (this.notes.state) this.renderNow();
    }
    return list;
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
    // Between a client-side navigation and the page swap (refresh) the old page's lyrics must
    // not be written under the new song's id.
    if (identityOf(page) !== this.identity) return;
    // Japanese lyrics are not translated: a stray seam or resume call must not spend a request.
    if (isJapanese(page) && !hasLines(this.record)) return;
    this.starting = true;
    let lock: LockHandle | null = null;
    let run: Run | null = null;
    let wakeSlow: ReturnType<typeof setTimeout> | undefined;
    const id = this.identity;
    // A retranslation is confirmed in the settings sheet, away from the page: if it cannot
    // start, say so in the head row instead of silently doing nothing.
    const cannotRetranslate = (detail: string) => {
      if (kind === 'retranslate' && this.identity === id) this.notice = { status: '訳し直せませんでした。今の訳はそのまま残っています', detail };
    };
    try {
      const settings = await loadSettings();
      if (!hasKey(settings)) {
        this.openFirstRun();
        return;
      }
      await this.refreshKeys();
      if (!this.avail.ok) {
        cannotRetranslate(`今日の無料枠は終わりました${this.avail.until > Date.now() ? `（${formatWhen(this.avail.until)}に戻ります）` : ''}`);
        this.renderNow();
        return;
      }
      const { source } = page;
      lock = await acquireLock(id, source.meta.title || '前の曲');
      if (!lock) {
        this.foreignLock = await this.otherLock();
        cannotRetranslate('別の曲を訳しています。終わってからもう一度');
        this.renderNow();
        return;
      }
      // Start from what storage has now: another tab may have finished this song while
      // this one sat in the background.
      const stored = this.acceptStored(id, page, await loadSong(id));
      if (stored && this.identity === id) this.record = stored;
      const retranslate = kind === 'retranslate' && hasLines(stored);
      if (!retranslate && stored && !missingLines(source, stored).length) {
        await lock.release();
        lock = null;
        this.renderNow();
        return;
      }
      const record: SongRecord = retranslate || !stored || !hasLines(stored) ? emptyRecord(id, page.path, source.meta) : structuredClone(stored);
      record.title = source.meta.title || record.title;
      record.artist = source.meta.artist || record.artist;
      // Saved progress says "closed" until the request ends, so a tab that dies mid-stream
      // leaves a resumable song rather than one that looks finished.
      record.stop = { reason: 'closed', at: Date.now() };

      run = { id, title: record.title, record, retranslate, controller: new AbortController(), saver: new SaveQueue(), lock, startedAt: Date.now() };
      this.run = run;
      // The slow-first-line sentence appears once 15 s have passed; no state change wakes a render by itself.
      wakeSlow = setTimeout(() => this.scheduleRender(), 15_100);
      this.starting = false;
      this.fromCache = false;
      this.notice = null;
      this.prefaceCollapsed = false;
      // Asking for Japanese means wanting to see it.
      delete record.hidden;
      if (this.record?.hidden) {
        delete this.record.hidden;
        await setSongHidden(id, false).catch(() => {});
      }
      const current = run;
      current.lock.start(() => current.controller.abort());
      // A reload or closed tab should not leave a live-looking lock for 10 s, and what it
      // leaves behind reads "ここまで訳してあります", not "ここで止めました".
      let leaving = false;
      // Write the newest lines at once: after pagehide the async save chain may never run,
      // and a backgrounded phone tab may be discarded without one.
      const bye = () => { leaving = true; void current.saver.flush(); current.controller.abort(); void current.lock.release(); };
      const hiddenNow = () => { if (document.visibilityState === 'hidden' && !retranslate) void current.saver.flush(); };
      window.addEventListener('pagehide', bye, { once: true });
      document.addEventListener('visibilitychange', hiddenNow);
      this.renderNow();

      try {
        // The tap waits for Genius' annotations only so long: a slow answer still lands in
        // this.annotations (and opened notes) later, but must not hold up the first request.
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        const annotations = await Promise.race([
          this.loadAnnotations(page),
          new Promise<GeniusAnnotation[]>((resolve) => { waitTimer = setTimeout(() => resolve(this.annotations ?? []), 2500); }),
        ]).finally(() => clearTimeout(waitTimer));
        const input = annotations.length ? { ...source, meta: { ...source.meta, annotations } } : source;
        const outcome = await translateSong(input, record, {
          apiKey: settings.apiKey,
          signal: current.controller.signal,
          onUpdate: () => {
            if (!retranslate) current.saver.schedule(record);
            this.scheduleRender();
          },
        });
        if (retranslate) {
          // Lines the new edition skipped (or a long song cut short) keep their previous
          // translation, so a retranslation that got most of the way still lands.
          // A retranslation that was cut ('length') or skipped lines ('gaps') still lands:
          // its holes keep the previous translation where there was one, and lines missing
          // from both keep the stop (S5g / S6) instead of discarding the whole new edition.
          let landed = outcome.complete;
          if (!landed && stored && outcome.stop && ['gaps', 'length'].includes(outcome.stop.reason)) {
            let carried = 0;
            for (const u of missingLines(source, record)) {
              const old = stored.lines[u.key];
              if (old?.ja) {
                record.lines[u.key] = old;
                carried += 1;
              }
            }
            // The new motifs stay; this only records that some lines may use the old wording.
            if (carried) record.carried = carried;
            if (!missingLines(source, record).length) delete record.stop;
            landed = true;
          }
          if (landed) {
            // The new edition stays on screen even when it could not be stored.
            if (this.identity === id) this.record = record;
            try {
              await saveSong(record);
              if (this.identity === id) this.unsaved = false;
            } catch (error) {
              console.error('[Lyric Lens]', error);
              if (this.identity === id) {
                this.notice = SAVE_FAILED;
                this.unsaved = true;
              }
            }
          } else if (this.identity === id) {
            const stop = outcome.stop ?? { reason: 'unusable', at: Date.now() };
            this.notice = { status: '訳し直せませんでした。今の訳はそのまま残っています', detail: failureText(stop, Date.now()) };
          }
        } else {
          if (leaving && record.stop?.reason === 'stopped') record.stop = { reason: 'closed', at: Date.now() };
          await this.persist(current, record);
        }
      } catch (error) {
        console.error('[Lyric Lens]', error);
        if (retranslate) {
          if (this.identity === id) this.notice = { status: '訳し直せませんでした。今の訳はそのまま残っています', detail: failureText({ reason: 'unusable', at: Date.now() }, Date.now()) };
        } else {
          record.stop = { reason: 'unusable', at: Date.now() };
          await this.persist(current, record);
        }
      } finally {
        window.removeEventListener('pagehide', bye);
        document.removeEventListener('visibilitychange', hiddenNow);
      }
    } finally {
      clearTimeout(wakeSlow);
      this.starting = false;
      // A storage failure while releasing must not leave this.run set (the tab would stay
      // stuck until reload). run is cleared only after release, so a new translate cannot
      // take the same-id lock and then have it removed by this release.
      try {
        if (lock) await lock.release();
      } catch (error) {
        console.error('[Lyric Lens]', error);
      } finally {
        if (run) {
          this.run = null;
          try {
            this.foreignLock = await this.otherLock();
            await this.refreshKeys();
          } catch (error) {
            console.error('[Lyric Lens]', error);
          }
          this.renderNow();
        }
      }
    }
  }

  /** Saves a finished request. A request that produced nothing is not an edition: it stays
   *  on this page (to say why) but is not stored — except an invalid key, which explains
   *  on later visits why 日本語で読む needs a new key. */
  private async persist(run: Run, record: SongRecord): Promise<void> {
    // Shown first: a storage failure (quota) must not erase what the reader already has.
    if (this.identity === record.id) this.record = record;
    try {
      await run.saver.flush();
      if (hasLines(record) || record.stop?.reason === 'auth') await saveSong(record);
      else await deleteSong(record.id);
      if (this.identity === record.id) this.unsaved = false;
    } catch (error) {
      console.error('[Lyric Lens]', error);
      if (this.identity === record.id && hasLines(record)) {
        this.notice = SAVE_FAILED;
        this.unsaved = true;
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

  /** 訳を隠す belongs to the song: it is saved on the record (without touching its date). */
  private async toggleHidden(): Promise<void> {
    const record = this.shown();
    if (!record) return;
    if (record.hidden) delete record.hidden;
    else record.hidden = true;
    this.renderNow();
    try {
      await setSongHidden(record.id, Boolean(record.hidden));
    } catch (e) {
      console.error('[Lyric Lens]', e);
    }
  }

  /** After the reader changed keys, an "invalid key" stop no longer applies: let the song
   *  offer 続きを訳す / 日本語で読む again. */
  /** An invalid-key stop needs no rewrite here: it stops applying (liveStop) as soon as a
   *  configured key is believed to work, on this page or any other. */
  private async afterSheet(): Promise<void> {
    await loadSettings();
    await this.refresh();
  }

  openSettings(anchor: HTMLElement | null): void {
    const record = this.record;
    const id = this.identity;
    // While a request is writing (here or in another tab) there is nothing to retranslate
    // or delete yet: a delete would be written back by the stream.
    const busy = Boolean(this.run || (this.foreignLock && this.foreignLock.id === id));
    openSheet({
      mode: 'settings',
      anchor,
      busySongId: busy ? id : null,
      // A first request that failed leaves no edition, but its error is what the reader needs.
      song: this.page && !busy && record && (hasLines(record) || record.stop?.detail)
        ? { title: record.title, model: record.model, translatedAt: record.updatedAt, ...(record.stop?.detail ? { lastError: record.stop.detail } : {}), ...(hasLines(record) ? {} : { edition: false }) }
        : null,
      onRetranslate: () => { if (this.identity === id) void this.translate('retranslate').catch((e) => console.error('[Lyric Lens]', e)); },
      onDeleteSong: async () => {
        if (!record || this.identity !== id || this.run) return;
        await deleteSong(record.id);
        this.record = null;
        this.unsaved = false;
        this.renderNow();
      },
      onClose: () => void this.afterSheet(),
    });
  }

  private openFirstRun(): void {
    openSheet({
      mode: 'first-run',
      onSaveAndTranslate: () => void this.translate('start').catch((e) => console.error('[Lyric Lens]', e)),
      onClose: () => void this.afterSheet(),
    });
  }
}
