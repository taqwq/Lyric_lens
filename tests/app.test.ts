import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongRecord, SongSource } from '../src/core/types';

const m = vi.hoisted(() => ({
  translateSong: vi.fn(),
  acquireLock: vi.fn(),
  render: vi.fn(),
  cleanOtherProviders: vi.fn(),
}));

// The controller is driven without a real page: the DOM-facing pieces are stubs.
vi.mock('../src/core/pipeline', () => ({ translateSong: m.translateSong }));
// The real housekeeping, wrapped so a test can see when it was called.
vi.mock('../src/llm/chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/chain')>();
  return { ...actual, cleanOtherProviders: m.cleanOtherProviders.mockImplementation(actual.cleanOtherProviders) };
});
vi.mock('../src/store/lock', () => ({ acquireLock: m.acquireLock, readLock: async () => null, requestAbort: async () => {}, TAB_ID: 'test-tab' }));
vi.mock('../src/ui/head', () => ({ HeadRow: class { render = m.render; clear = vi.fn(); focusFirst = vi.fn(); element = null; } }));
vi.mock('../src/ui/lines', () => ({ LineRenderer: class { render = vi.fn(); clear = vi.fn(); nodeFor = () => undefined; damaged = () => false; } }));
vi.mock('../src/ui/notes', () => ({ NoteView: class { state = null; openIndex = null; close = vi.fn(); } }));
vi.mock('../src/ui/sheet', () => ({ openSheet: vi.fn(), closeSheet: vi.fn() }));

import { App } from '../src/app';
import { buildSong, emptyRecord } from '../src/core/song';
import { readPage, type PageSong } from '../src/genius/extract';
import { memoryStorage, setKV, type KV } from '../src/platform/storage';
import { loadSettings, setApiKey } from '../src/store/settings';
import { loadSong, saveSong } from '../src/store/songs';

interface Inside {
  page: PageSong | null;
  identity: string;
  record: SongRecord | null;
  run: unknown;
  notice: { status: string; detail: string } | null;
  unsaved: boolean;
  annotations: unknown[] | null;
  lines: { render: ReturnType<typeof vi.fn> };
  renderNow(): void;
  opening: boolean;
  act(id: string, el: HTMLElement | null, input: unknown): void;
  toggleHidden(): Promise<void>;
  followLyricFont(page: PageSong): void;
  loadAnnotations(page: PageSong): Promise<unknown[]>;
}

const inside = (app: App) => app as unknown as Inside;

const ENGLISH = ['I walk the quiet street', 'Hold the light', 'Down the road we go'];
const JAPANESE = ['きみのこえが とおくで ひびく', '夜明け前の街を歩く', 'いつかの空を見上げて', 'もういちど あしたへ'];

function pageOf(texts: string[], over: Partial<PageSong> = {}): PageSong {
  const source: SongSource = buildSong({ title: 'T', artist: 'A' }, texts.map((text) => ({ kind: 'line', text })));
  return { path: '/artist-title-lyrics', songId: null, source, anchors: [], texts: [], containers: [], ...over };
}

const identityOf = (page: PageSong) => (page.songId ? `id:${page.songId}` : `path:${page.path}`);

/** An App sitting on `page`, as refresh() would leave it. */
function appOn(page: PageSong, record: SongRecord | null = null): App {
  const app = new App();
  const s = inside(app);
  s.page = page;
  s.identity = identityOf(page);
  s.record = record;
  return app;
}

function lock(release: () => Promise<void> = async () => {}) {
  return { start: vi.fn(), release: vi.fn(release) };
}

const failing = { on: false };

/** The newest head view the controller rendered. */
const headView = (): {
  state: string; tone: string; status: string; settle?: boolean; count?: string; progress: unknown;
  captions: { text: string; tone?: string }[]; actions: { id: string; label: string }[];
} => m.render.mock.calls.at(-1)![1];

beforeEach(async () => {
  const inner = memoryStorage();
  const kv: KV = { ...inner, set: async (key, value) => { if (failing.on) throw new Error('quota'); await inner.set(key, value); } };
  failing.on = false;
  setKV(kv);
  await loadSettings();
  await setApiKey('test-key');
  m.translateSong.mockReset();
  m.acquireLock.mockReset();
  m.render.mockReset();
  m.acquireLock.mockImplementation(async () => lock());
  // Fills the first three lines, then finishes.
  m.translateSong.mockImplementation(async (source: SongSource, record: SongRecord, options: { onUpdate: () => void }) => {
    for (const u of source.unique.slice(0, 3)) record.lines[u.key] = { ja: `訳${u.uid}` };
    options.onUpdate();
    delete record.stop;
    return { record, complete: true, model: 'test' };
  });
});

describe('translate: Japanese lyrics', () => {
  it('shows the quiet Japanese state instead of the start button, and sends nothing', async () => {
    const app = appOn(pageOf(JAPANESE));
    inside(app).renderNow();
    expect(headView().state).toBe('SJ');
    await app.translate('start');
    expect(m.acquireLock).not.toHaveBeenCalled();
    expect(m.translateSong).not.toHaveBeenCalled();
  });

  it('still resumes a Japanese song that already has an edition', async () => {
    const page = pageOf(JAPANESE);
    const record = emptyRecord(identityOf(page), page.path, page.source.meta);
    record.lines[page.source.unique[0]!.key] = { ja: '訳' };
    record.stop = { reason: 'busy', at: 1 };
    await saveSong(record);
    await appOn(page, record).translate('resume');
    expect(m.translateSong).toHaveBeenCalledTimes(1);
  });

  it('translates an English song as before', async () => {
    const app = appOn(pageOf(ENGLISH));
    inside(app).renderNow();
    expect(headView().state).toBe('S2');
    await app.translate('start');
    expect(m.translateSong).toHaveBeenCalledTimes(1);
    expect(inside(app).unsaved).toBe(false);
  });
});

describe('translate: navigation window', () => {
  it('does not use the old page lyrics under the new song identity', async () => {
    const app = appOn(pageOf(ENGLISH));
    inside(app).identity = 'id:999';
    await app.translate('start');
    expect(m.acquireLock).not.toHaveBeenCalled();
    expect(m.translateSong).not.toHaveBeenCalled();
    expect(inside(app).run).toBeNull();
    expect(await loadSong('id:999')).toBeNull();
  });

  it('starts when the identity matches', async () => {
    await appOn(pageOf(ENGLISH)).translate('start');
    expect(m.translateSong).toHaveBeenCalledTimes(1);
  });
});

describe('translate: the finished edition cannot be saved', () => {
  it('keeps the translation on screen and says it was not saved', async () => {
    m.translateSong.mockImplementationOnce(async (source: SongSource, record: SongRecord, options: { onUpdate: () => void }) => {
      failing.on = true;
      for (const u of source.unique.slice(0, 3)) record.lines[u.key] = { ja: `訳${u.uid}` };
      options.onUpdate();
      return { record, complete: true, model: 'test' };
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = pageOf(ENGLISH);
    const app = appOn(page);
    await app.translate('start');
    expect(Object.keys(inside(app).record!.lines)).toHaveLength(3);
    expect(inside(app).run).toBeNull();
    expect(inside(app).notice?.status).toBe('保存できませんでした');
    // A same-song refresh must not replace it with what storage has (nothing).
    expect(inside(app).unsaved).toBe(true);
    expect(headView()).toMatchObject({ state: 'S8f', tone: 'settled', status: 'AIによる日本語訳' });
    expect(headView().captions[0]).toEqual({ text: '保存できませんでした' });
    expect(log).toHaveBeenCalled();
    failing.on = false;
    expect(await loadSong(identityOf(page))).toBeNull();
    log.mockRestore();
  });

  it('records how many lines a landed retranslation carried over from the old edition', async () => {
    const page = pageOf(ENGLISH);
    const old = emptyRecord(identityOf(page), page.path, page.source.meta);
    for (const u of page.source.unique) old.lines[u.key] = { ja: '古い訳' };
    await saveSong(old);
    m.translateSong.mockImplementationOnce(async (source: SongSource, record: SongRecord) => {
      record.song = { who: '新', what: '新しい版', motifs: [{ en: 'a', ja: 'あ' }] };
      for (const u of source.unique.slice(0, 2)) record.lines[u.key] = { ja: '新しい訳' };
      return { record, complete: false, model: 'test', stop: { reason: 'gaps', at: Date.now() } };
    });
    const app = appOn(page, old);
    await app.translate('retranslate');
    const saved = (await loadSong(identityOf(page)))!;
    expect(saved.carried).toBe(page.source.unique.length - 2);
    expect(saved.song?.motifs).toEqual([{ en: 'a', ja: 'あ' }]);
    expect(saved.lines[page.source.unique[0]!.key]!.ja).toBe('新しい訳');
  });

  it('keeps a retranslated edition on screen when it cannot be stored', async () => {
    const page = pageOf(ENGLISH);
    const old = emptyRecord(identityOf(page), page.path, page.source.meta);
    for (const u of page.source.unique) old.lines[u.key] = { ja: '古い訳' };
    await saveSong(old);
    m.translateSong.mockImplementationOnce(async (source: SongSource, record: SongRecord) => {
      failing.on = true;
      for (const u of source.unique) record.lines[u.key] = { ja: '新しい訳' };
      delete record.stop;
      return { record, complete: true, model: 'test' };
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = appOn(page, old);
    await app.translate('retranslate');
    expect(Object.values(inside(app).record!.lines).every((l) => l.ja === '新しい訳')).toBe(true);
    expect(inside(app).notice?.status).toBe('保存できませんでした');
    failing.on = false;
    expect((await loadSong(identityOf(page)))!.lines[page.source.unique[0]!.key]!.ja).toBe('古い訳');
    log.mockRestore();
  });
});

describe('translate: a lock that cannot be released', () => {
  it('still clears the run, renders, and accepts the next request', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.acquireLock.mockImplementationOnce(async () => lock(async () => { throw new Error('storage'); }));
    const app = appOn(pageOf(ENGLISH));
    await app.translate('start');
    expect(inside(app).run).toBeNull();
    const rendered = m.render.mock.calls.length;
    expect(rendered).toBeGreaterThan(0);
    expect(log).toHaveBeenCalled();
    // The edition is complete now: a second request reaches the lock and finds nothing to do.
    await app.translate('start');
    expect(m.acquireLock).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('renders the finished state after the failed release', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.acquireLock.mockImplementationOnce(async () => lock(async () => { throw new Error('storage'); }));
    const app = appOn(pageOf(ENGLISH));
    const before = m.render.mock.calls.length;
    await app.translate('start');
    expect(m.render.mock.calls.length).toBeGreaterThan(before);
    expect(headView().state).toBe('S5');
    log.mockRestore();
  });
});

describe('loadAnnotations', () => {
  const referent = (n: number) => ({ id: n, fragment: `invented fragment ${n}`, annotations: [{ body: { plain: `invented note ${n}` }, votes_total: 5 }] });
  const answer = (referents: unknown[]) => ({ ok: true, json: async () => ({ response: { referents, next_page: null } }) });

  it('retries after a failed fetch instead of remembering "no annotations"', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(answer([referent(1), referent(2)]));
    vi.stubGlobal('fetch', fetchMock);
    const page = pageOf(ENGLISH, { songId: '7001' });
    const app = appOn(page);
    expect(await inside(app).loadAnnotations(page)).toEqual([]);
    expect(inside(app).annotations).toBeNull();
    expect(await inside(app).loadAnnotations(page)).toHaveLength(2);
    expect(inside(app).annotations).toHaveLength(2);
    expect(await inside(app).loadAnnotations(page)).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('asks Genius once when it answered with no annotations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer([]));
    vi.stubGlobal('fetch', fetchMock);
    const page = pageOf(ENGLISH, { songId: '7002' });
    const app = appOn(page);
    for (let i = 0; i < 3; i++) expect(await inside(app).loadAnnotations(page)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('translate: the tap does not wait long for Genius annotations', () => {
  // 'Sit down, be humble' / 'Count the cash twice'
  const LINES = ['Sit down, be humble', 'Count the cash twice'];
  const referent = (n: number) => ({ id: n, fragment: `invented fragment ${n}`, annotations: [{ body: { plain: `invented note ${n}` }, votes_total: 5 }] });
  const slowAnswer = (ms: number) => vi.fn(() => new Promise((resolve) => {
    setTimeout(() => resolve({ ok: true, json: async () => ({ response: { referents: [referent(1), referent(2)], next_page: null } }) }), ms);
  }));
  const metaOf = () => (m.translateSong.mock.calls[0]![0] as SongSource).meta as { annotations?: unknown[] };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts the request by 2500 ms without them, and keeps the late fetch for the notes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', slowAnswer(5000));
    const app = appOn(pageOf(LINES, { songId: '7101' }));
    const done = app.translate('start');
    await vi.advanceTimersByTimeAsync(2400);
    expect(m.translateSong).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(m.translateSong).toHaveBeenCalledTimes(1);
    expect(metaOf().annotations).toBeUndefined();
    await done;
    expect(inside(app).annotations).toBeNull();
    await vi.advanceTimersByTimeAsync(2500);
    expect(inside(app).annotations).toHaveLength(2);
  });

  it('includes them when Genius answers within the wait', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', slowAnswer(100));
    const app = appOn(pageOf(LINES, { songId: '7102' }));
    const done = app.translate('start');
    await vi.advanceTimersByTimeAsync(200);
    expect(m.translateSong).toHaveBeenCalledTimes(1);
    expect(metaOf().annotations).toHaveLength(2);
    await done;
  });

  it('leaves no timer behind once the annotations won the race', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', slowAnswer(100));
    const app = appOn(pageOf(LINES, { songId: '7103' }));
    const done = app.translate('start');
    await vi.advanceTimersByTimeAsync(200);
    await done;
    // Let the 120 ms render debounce run out: the 2.5 s wait must not still be pending.
    await vi.advanceTimersByTimeAsync(130);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('start: housekeeping does not delay the first paint', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('paints the saved translation while cleanOtherProviders is still waiting, and still runs it once', async () => {
    vi.useFakeTimers();
    m.cleanOtherProviders.mockClear();
    // 'Sit down' -> 'まあ座れよ'
    document.body.innerHTML = '<div data-lyrics-container="true">Sit down<br>Count the cash twice</div>';
    const page = readPage()!;
    const inner = memoryStorage();
    setKV(inner);
    await loadSettings();
    await setApiKey('test-key');
    const record = emptyRecord(identityOf(page), page.path, page.source.meta);
    record.lines[page.source.unique[0]!.key] = { ja: 'まあ座れよ' };
    record.stop = { reason: 'closed', at: 1 };
    await saveSong(record);

    // The key scan behind the housekeeping only finishes when released.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let scanning = false;
    setKV({ ...inner, keys: async () => { scanning = true; await gate; return inner.keys(); } });

    const app = new App();
    await app.start();

    const painted = inside(app).lines.render.mock.calls.at(-1)?.[0] as { record: SongRecord | null } | undefined;
    expect(Object.values(painted?.record?.lines ?? {}).map((l) => l.ja)).toContain('まあ座れよ');
    expect(m.cleanOtherProviders).toHaveBeenCalledTimes(1);
    expect(m.cleanOtherProviders).toHaveBeenCalledWith('test-key');
    expect(scanning).toBe(true);

    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(m.cleanOtherProviders).toHaveBeenCalledTimes(1);
  });
});

describe('head view mapping', () => {
  const runningApp = (done: number): App => {
    const page = pageOf(ENGLISH);
    const record = emptyRecord(identityOf(page), page.path, page.source.meta);
    for (const u of page.source.unique.slice(0, done)) record.lines[u.key] = { ja: `訳${u.uid}` };
    const app = appOn(page);
    Object.assign(app, { run: { id: identityOf(page), title: 'T', record, retranslate: false, startedAt: Date.now() } });
    return app;
  };

  it('S4 carries the count text and the progress of the lines in', () => {
    const app = runningApp(2);
    inside(app).renderNow();
    expect(headView()).toMatchObject({ state: 'S4', tone: 'speaking', status: '訳しています', count: '（2/3行）', progress: { value: 2, max: 3 } });
    expect(headView().settle).toBeUndefined();
  });

  it('S3 is indeterminate and has no count', () => {
    const app = runningApp(0);
    inside(app).renderNow();
    expect(headView()).toMatchObject({ state: 'S3', status: '曲全体を読んでいます', progress: 'indeterminate' });
    expect(headView()).not.toHaveProperty('count');
  });

  it('a run in this session that reaches S5 settles the head exactly once', () => {
    const page = pageOf(ENGLISH);
    const id = identityOf(page);
    const app = appOn(page);
    // A render while the request is in flight marks that this tab wrote.
    Object.assign(app, { run: { id, title: 'T', record: emptyRecord(id, page.path, page.source.meta), retranslate: false, startedAt: Date.now() } });
    inside(app).renderNow();
    Object.assign(app, { run: null });
    const done = emptyRecord(id, page.path, page.source.meta);
    for (const u of page.source.unique) done.lines[u.key] = { ja: '訳' };
    inside(app).record = done;
    inside(app).renderNow();
    expect(headView()).toMatchObject({ state: 'S5', tone: 'settled', settle: true });
    inside(app).renderNow();
    expect(headView().settle).toBeUndefined();
  });

  it('a saved song opened fresh never settles', () => {
    const page = pageOf(ENGLISH);
    const record = emptyRecord(identityOf(page), page.path, page.source.meta);
    for (const u of page.source.unique) record.lines[u.key] = { ja: '訳' };
    const app = appOn(page, record);
    inside(app).renderNow();
    expect(headView()).toMatchObject({ state: 'S5' });
    expect(headView().settle).toBeUndefined();
  });
});

describe('opening flag for the line renderer', () => {
  const linesInput = (app: App) => inside(app).lines.render.mock.calls.at(-1)![0] as { opening?: boolean };
  const withRun = (): App => {
    const page = pageOf(ENGLISH);
    const app = appOn(page);
    Object.assign(app, { run: { id: identityOf(page), title: 'T', record: emptyRecord(identityOf(page), page.path, page.source.meta), retranslate: false, startedAt: Date.now() } });
    return app;
  };

  it('日本語で読む and 続きを訳す raise it', () => {
    for (const id of ['start', 'resume']) {
      const app = new App();
      vi.spyOn(app, 'translate').mockResolvedValue();
      inside(app).act(id, null, {});
      expect(inside(app).opening).toBe(true);
    }
  });

  it('is passed once, on the first render that shows the running slots', () => {
    const app = withRun();
    inside(app).opening = true;
    inside(app).renderNow();
    expect(linesInput(app).opening).toBe(true);
    inside(app).renderNow();
    expect(linesInput(app)).not.toHaveProperty('opening');
  });

  it('waits while no request runs here (it is never spent on a cached render)', () => {
    const app = appOn(pageOf(ENGLISH));
    inside(app).opening = true;
    inside(app).renderNow();
    expect(linesInput(app)).not.toHaveProperty('opening');
    expect(inside(app).opening).toBe(true);
  });
});

describe('--ll-latin', () => {
  it('follows the lyrics container font family', () => {
    const el = document.createElement('div');
    el.style.fontFamily = 'Georgia, serif';
    document.body.appendChild(el);
    const app = appOn(pageOf(ENGLISH, { containers: [el] }));
    inside(app).followLyricFont(inside(app).page!);
    expect(document.documentElement.style.getPropertyValue('--ll-latin')).toContain('Georgia');
    el.remove();
  });

  it('does nothing without a container', () => {
    document.documentElement.style.removeProperty('--ll-latin');
    const app = appOn(pageOf(ENGLISH));
    expect(() => inside(app).followLyricFont(inside(app).page!)).not.toThrow();
    expect(document.documentElement.style.getPropertyValue('--ll-latin')).toBe('');
  });
});

describe('訳を隠す is per song', () => {
  const finished = (): { page: PageSong; record: SongRecord } => {
    const page = pageOf(ENGLISH);
    const record = emptyRecord(identityOf(page), page.path, page.source.meta);
    for (const u of page.source.unique) record.lines[u.key] = { ja: '訳' };
    return { page, record };
  };
  afterEach(() => { document.documentElement.classList.remove('ll-hidden'); });

  it('toggling saves the flag on the record, follows it with html.ll-hidden and leaves the global setting alone', async () => {
    const { page, record } = finished();
    await saveSong(record);
    const stamp = (await loadSong(record.id))!.updatedAt;
    const app = appOn(page, record);
    await inside(app).toggleHidden();
    expect(document.documentElement.classList.contains('ll-hidden')).toBe(true);
    expect(headView()).toMatchObject({ state: 'S5', status: '訳を隠しています' });
    expect(headView().actions.map((a) => a.label)).toEqual(['訳を表示', '設定']);
    const saved = (await loadSong(record.id))!;
    expect(saved.hidden).toBe(true);
    expect(saved.updatedAt).toBe(stamp);
    expect((await loadSettings()).hideTranslation).toBe(false);
    await inside(app).toggleHidden();
    expect(document.documentElement.classList.contains('ll-hidden')).toBe(false);
    expect(await loadSong(record.id)).not.toHaveProperty('hidden');
  });

  it('another song starts shown: the class follows the song on screen', () => {
    const { page, record } = finished();
    record.hidden = true;
    const app = appOn(page, record);
    inside(app).renderNow();
    expect(document.documentElement.classList.contains('ll-hidden')).toBe(true);
    const other = appOn(pageOf(ENGLISH, { path: '/other-lyrics' }), null);
    inside(other).renderNow();
    expect(document.documentElement.classList.contains('ll-hidden')).toBe(false);
  });

  it('asking for Japanese again (resume) shows the translation', async () => {
    const { page, record } = finished();
    delete record.lines[page.source.unique[0]!.key];
    record.stop = { reason: 'stopped', at: 1 };
    record.hidden = true;
    await saveSong(record);
    const app = appOn(page, record);
    await app.translate('resume');
    expect((await loadSong(record.id))!.hidden).toBeUndefined();
    expect(document.documentElement.classList.contains('ll-hidden')).toBe(false);
  });
});
