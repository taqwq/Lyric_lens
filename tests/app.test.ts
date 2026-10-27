import './setup';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongRecord, SongSource } from '../src/core/types';

const m = vi.hoisted(() => ({
  translateSong: vi.fn(),
  acquireLock: vi.fn(),
  render: vi.fn(),
}));

// The controller is driven without a real page: the DOM-facing pieces are stubs.
vi.mock('../src/core/pipeline', () => ({ translateSong: m.translateSong }));
vi.mock('../src/store/lock', () => ({ acquireLock: m.acquireLock, readLock: async () => null, requestAbort: async () => {}, TAB_ID: 'test-tab' }));
vi.mock('../src/ui/head', () => ({ HeadRow: class { render = m.render; clear = vi.fn(); focusFirst = vi.fn(); element = null; } }));
vi.mock('../src/ui/lines', () => ({ LineRenderer: class { render = vi.fn(); clear = vi.fn(); nodeFor = () => undefined; damaged = () => false; } }));
vi.mock('../src/ui/notes', () => ({ NoteView: class { state = null; openIndex = null; close = vi.fn(); } }));
vi.mock('../src/ui/sheet', () => ({ openSheet: vi.fn(), closeSheet: vi.fn() }));

import { App } from '../src/app';
import { buildSong, emptyRecord } from '../src/core/song';
import type { PageSong } from '../src/genius/extract';
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
  renderNow(): void;
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
const headView = (): { state: string; status: string } => m.render.mock.calls.at(-1)![1];

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
    expect(headView()).toMatchObject({ state: 'S8f', status: '保存できませんでした' });
    expect(log).toHaveBeenCalled();
    failing.on = false;
    expect(await loadSong(identityOf(page))).toBeNull();
    log.mockRestore();
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
