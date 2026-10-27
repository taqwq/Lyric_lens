import './setup';

import { describe, expect, it } from 'vitest';
import type { StopInfo, StopReason } from '../src/core/types';
import { decide, failureText, liveStop, seamFor, seamText, startFailText, type ActionSpec, type Decision, type SeamSpec, type ViewInput } from '../src/ui/state';
import { formatWhen } from '../src/ui/time';

/* The reading surface's state machine (docs/DESIGN.md §3, S0–S8f). The code is the source of
 * truth for every sentence: these tests pin the exact strings, ids, labels and flags. */

const NOW = Date.UTC(2026, 9, 26, 3, 0); // 12:00 in Japan
const HOUR = 3_600_000;
const SOON = NOW + 3 * HOUR; // 15:00 the same day in Japan
const TOMORROW = NOW + 13 * HOUR; // 01:00 the next day in Japan
const MINUTE_LATER = NOW + 60_000;

const base: ViewInput = {
  now: NOW,
  online: true,
  streams: true,
  hidden: false,
  hasKey: true,
  keyBad: false,
  total: 40,
  done: 0,
  stop: undefined,
  hasPreface: false,
  running: 'none',
  mirrored: false,
  otherSong: null,
  avail: { ok: true, until: 0 },
  notice: null,
};

const view = (over: Partial<ViewInput> = {}): ViewInput => ({ ...base, ...over });
const stopOf = (reason: StopReason, extra: Partial<StopInfo> = {}): StopInfo => ({ reason, at: NOW - 5_000, ...extra });
const at = (until: number) => formatWhen(until, NOW);

const SETTINGS: ActionSpec = { id: 'settings', label: '設定' };
const STOP: ActionSpec = { id: 'stop', label: '止める' };
const HIDE: ActionSpec = { id: 'hide', label: '訳を隠す' };
const SHOW: ActionSpec = { id: 'hide', label: '訳を表示' };
const START: ActionSpec = { id: 'start', label: '日本語で読む', primary: true };
const NONE = { slots: false, gaps: false, breathing: false, seam: null };
const WRITING = { slots: true, gaps: false, breathing: true, seam: null };

const BLOCKED_BY_OTHER = '別の曲を訳し終えると続きを訳せます';
const quotaBlocker = (until: number) => `今日の無料枠は終わりました。${at(until)}から訳せます`;

/** toEqual ignores undefined properties; this also fails on a stray `note: undefined`/`tone`. */
function expectDecision(actual: Decision, expected: Decision): void {
  expect(actual).toEqual(expected);
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
}

describe('fixture', () => {
  it('NOW is noon in Japan and the helper times read as expected', () => {
    expect(at(SOON)).toBe('15:00');
    expect(at(TOMORROW)).toBe('明日 01:00');
    expect(at(NOW)).toBe('12:00');
  });
});

/* ---------- S1 / S2 family: nothing translated yet ---------- */

describe('S1 no key', () => {
  it('asks for a key with one primary button', () => {
    expectDecision(decide(view({ hasKey: false })), {
      state: 'S1',
      status: '日本語訳には無料のAPIキーが必要です',
      actions: [{ id: 'firstRun', label: 'キーを設定', primary: true }],
      preface: false,
      lines: NONE,
    });
  });

  it('beats the other-song, quota and stored-stop states', () => {
    const d = decide(view({ hasKey: false, otherSong: 'X', avail: { ok: false, until: SOON }, stop: stopOf('busy') }));
    expect(d.state).toBe('S1');
  });

  it('only applies while nothing is translated: with lines on the page it is the usual S6/S7', () => {
    expect(decide(view({ hasKey: false, done: 10, stop: stopOf('busy') })).state).toBe('S6');
    expect(decide(view({ hasKey: false, done: 10 })).state).toBe('S7');
  });
});

describe('S2 ready', () => {
  it('offers 日本語で読む and 設定', () => {
    expectDecision(decide(base), { state: 'S2', status: '', actions: [START, SETTINGS], preface: false, lines: NONE });
  });

  it('ignores a preface and the hide switch before anything is written', () => {
    expectDecision(decide(view({ hasPreface: true, hidden: true })), { state: 'S2', status: '', actions: [START, SETTINGS], preface: false, lines: NONE });
  });

  it.each<[string, Partial<ViewInput>]>([
    ['no stop recorded', {}],
    ['stopped by the reader', { stop: stopOf('stopped') }],
    ['closed tab', { stop: stopOf('closed') }],
    ['rate limit whose wait is over', { stop: stopOf('rate', { until: NOW - 1 }) }],
    ['rate limit that ends exactly now', { stop: stopOf('rate', { until: NOW }) }],
    ['daily quota that is available again', { stop: stopOf('quota', { until: SOON }), avail: { ok: true, until: 0 } }],
    ['quota stop with nothing known to block it', { stop: stopOf('quota') }],
    ['auth stop but no key is rejected any more', { stop: stopOf('auth'), keyBad: false }],
  ])('stays plain S2 for %s', (_name, over) => {
    expectDecision(decide(view(over)), { state: 'S2', status: '', actions: [START, SETTINGS], preface: false, lines: NONE });
  });

  it('ignores a retranslation notice while nothing is translated', () => {
    expect(decide(view({ notice: { status: 's', detail: 'd' } })).state).toBe('S2');
  });
});

describe('SJ Japanese lyrics', () => {
  const japanese = view({ japanese: true });

  it('says so quietly and offers no way to start a request', () => {
    expectDecision(decide(japanese), {
      state: 'SJ',
      status: 'この曲は日本語の歌詞です',
      tone: 'muted',
      actions: [],
      preface: false,
      lines: NONE,
    });
    const ids = decide(japanese).actions.map((a) => a.id);
    expect(ids).not.toContain('start');
    expect(ids).not.toContain('firstRun');
  });

  it('beats the no-key, other-song, quota and stored-stop states', () => {
    expect(decide(view({ japanese: true, hasKey: false })).state).toBe('SJ');
    expect(decide(view({ japanese: true, otherSong: 'X' })).state).toBe('SJ');
    expect(decide(view({ japanese: true, avail: { ok: false, until: SOON } })).state).toBe('SJ');
    expect(decide(view({ japanese: true, stop: stopOf('busy') })).state).toBe('SJ');
  });

  it('yields to a running request, another tab and a saved edition', () => {
    expect(decide(view({ japanese: true, running: 'here' })).state).toBe('S3');
    expect(decide(view({ japanese: true, mirrored: true })).state).toBe('S4m');
    expect(decide(view({ japanese: true, done: 40 })).state).toBe('S5');
    expect(decide(view({ japanese: true, done: 10, stop: stopOf('busy') })).state).toBe('S6');
  });

  it('is off by default and when false', () => {
    expect(decide(base).state).toBe('S2');
    expect(decide(view({ japanese: false })).state).toBe('S2');
  });
});

describe('S2b another song is being written', () => {
  it('names the other song and offers to stop it', () => {
    expectDecision(decide(view({ otherSong: 'Hello' })), {
      state: 'S2b',
      status: '別の曲（Hello）を訳しています · 終わると訳せます',
      actions: [{ id: 'stopOther', label: 'あちらを止める' }, SETTINGS],
      preface: false,
      lines: NONE,
    });
  });

  it('beats quota and a stored failure', () => {
    expect(decide(view({ otherSong: 'Hello', avail: { ok: false, until: SOON }, stop: stopOf('busy') })).state).toBe('S2b');
  });
});

describe('S2q quota known exhausted', () => {
  it('the reset time and 設定', () => {
    const d = decide(view({ avail: { ok: false, until: SOON } }));
    expectDecision(d, {
      state: 'S2q',
      status: '今日の無料枠は終わりました。15:00から訳せます',
      tone: 'muted',
      actions: [SETTINGS],
      preface: false,
      lines: NONE,
    });
    expect(d.status).toBe(quotaBlocker(SOON));
  });

  it('says 明日 when the reset is on the next day in Japan', () => {
    expect(decide(view({ avail: { ok: false, until: TOMORROW } })).status).toBe('今日の無料枠は終わりました。明日 01:00から訳せます');
  });

  it.each([
    ['unknown reset (0)', 0],
    ['reset already in the past', NOW - 1],
    ['reset exactly now', NOW],
  ])('says あとで for %s', (_name, until) => {
    const d = decide(view({ avail: { ok: false, until } }));
    expect(d.state).toBe('S2q');
    expect(d.status).toBe('今日の無料枠は終わりました。あとで訳せます');
  });

  it('beats a stored first-request failure', () => {
    expect(decide(view({ avail: { ok: false, until: SOON }, stop: stopOf('busy') })).state).toBe('S2q');
  });

  it('is below S2b: another song running is the more useful thing to say', () => {
    const d = decide(view({ avail: { ok: false, until: SOON }, otherSong: 'Hello' }));
    expect(d.state).toBe('S2b');
  });
});

describe('S2f the first request produced nothing', () => {
  const plain = (extra: Partial<ActionSpec> = {}): ActionSpec => ({ id: 'start', label: '日本語で読む', primary: true, disabled: false, ...extra });

  const rows: Array<{ name: string; stop: StopInfo; over?: Partial<ViewInput>; status: string; button?: Partial<ActionSpec> }> = [
    { name: 'busy', stop: stopOf('busy'), status: 'AIが混み合っていて、訳し始められませんでした。少しおいてからもう一度どうぞ' },
    { name: 'rate before until (button waits)', stop: stopOf('rate', { until: MINUTE_LATER }), status: 'AIの回数制限にかかりました。1分ほどおいてから訳せます', button: { disabled: true } },
    { name: 'rate one ms before until', stop: stopOf('rate', { until: MINUTE_LATER }), over: { now: MINUTE_LATER - 1 }, status: 'AIの回数制限にかかりました。1分ほどおいてから訳せます', button: { disabled: true } },
    { name: 'rate without a known until', stop: stopOf('rate'), status: 'AIの回数制限にかかりました。1分ほどおいてから訳せます' },
    { name: 'blocked', stop: stopOf('blocked'), status: 'この曲はAIの安全フィルタで止められました。もう一度試すと通ることがあります' },
    { name: 'network, online', stop: stopOf('network'), over: { online: true }, status: '接続が切れて、訳し始められませんでした。つながったら訳せます' },
    { name: 'network, offline (button waits)', stop: stopOf('network'), over: { online: false }, status: '接続が切れて、訳し始められませんでした。つながったら訳せます', button: { disabled: true } },
    { name: 'rejected', stop: stopOf('rejected'), status: 'AIがこの依頼を受け付けませんでした。もう一度試すと別のモデルで訳せることがあります' },
    { name: 'no-model', stop: stopOf('no-model'), status: '使えるAIのモデルが見つかりませんでした。少しおいてからもう一度どうぞ' },
    { name: 'empty', stop: stopOf('empty'), status: 'AIから空の返事が返ってきました。もう一度試せます' },
    { name: 'unusable', stop: stopOf('unusable'), status: 'AIの返事をうまく読み取れませんでした。もう一度試せます' },
    { name: 'length', stop: stopOf('length'), status: '長い曲なので、一度では訳し切れませんでした' },
  ];

  it.each(rows)('$name', ({ stop, over, status, button }) => {
    expectDecision(decide(view({ stop, ...over })), {
      state: 'S2f',
      status,
      actions: [plain(button), SETTINGS],
      preface: false,
      lines: NONE,
    });
  });

  it('auth with a rejected key: 設定を開く is the only (primary) button', () => {
    expectDecision(decide(view({ stop: stopOf('auth'), keyBad: true })), {
      state: 'S2f',
      status: 'APIキーが使えなくなりました。設定でキーを入れ直してください',
      actions: [{ id: 'settings', label: '設定を開く', primary: true }],
      preface: false,
      lines: NONE,
    });
  });

  it('auth with a key that is not known to be bad reads as plain S2', () => {
    expect(decide(view({ stop: stopOf('auth'), keyBad: false })).state).toBe('S2');
  });

  it('the start button keeps its place whatever the preface/hide inputs say', () => {
    const d = decide(view({ stop: stopOf('busy'), hasPreface: true, hidden: true }));
    expect(d.state).toBe('S2f');
    expect(d.preface).toBe(false);
    expect(d.actions).toEqual([plain(), SETTINGS]);
  });

  it('a quota stop never reaches S2f: S2q while the quota is spent, plain S2 once it is not', () => {
    expect(decide(view({ stop: stopOf('quota', { until: SOON }), avail: { ok: false, until: SOON } })).state).toBe('S2q');
    expect(decide(view({ stop: stopOf('quota', { until: SOON }), avail: { ok: true, until: 0 } })).state).toBe('S2');
  });

  it('a rate stop whose wait ended reads as plain S2', () => {
    expect(decide(view({ stop: stopOf('rate', { until: NOW - 1 }) })).state).toBe('S2');
  });
});

/* ---------- writing ---------- */

describe('S3 reading the whole song first', () => {
  it('is just 止める', () => {
    expectDecision(decide(view({ running: 'here' })), {
      state: 'S3',
      status: '曲全体を読んでいます',
      actions: [STOP],
      preface: false,
      lines: WRITING,
    });
  });

  it('says answers arrive all at once when the transport buffers', () => {
    expectDecision(decide(view({ running: 'here', streams: false })), {
      state: 'S3',
      status: '曲全体を読んでいます',
      note: 'この環境では訳がまとめて届きます',
      actions: [STOP],
      preface: false,
      lines: WRITING,
    });
  });

  const WAIT = '返事を待っています。混んでいると1分ほどかかることもあります';
  const slowBase = { running: 'here' as const, hasPreface: false, done: 0, total: 24, streams: true };

  it('stays quiet before 15 s', () => {
    const d = decide(view({ ...slowBase, waitedMs: 5_000 }));
    expect(d.state).toBe('S3');
    expect(d.status).toBe('曲全体を読んでいます');
    expect(d.note).toBeUndefined();
  });

  it('says the wait is expected once the first line is 15 s late', () => {
    const d = decide(view({ ...slowBase, waitedMs: 16_000 }));
    expect(d.state).toBe('S3');
    expect(d.status).toBe('曲全体を読んでいます');
    expect(d.note).toBe(WAIT);
    expect(d.actions).toEqual([STOP]);
  });

  it('drops the wait sentence once a line (I been on the road since the sun went down) has arrived', () => {
    const d = decide(view({ ...slowBase, done: 1, waitedMs: 16_000 }));
    expect(d.state).toBe('S4');
    expect(d.note).toBeUndefined();
  });

  it('joins the wait and buffered sentences when the transport does not stream', () => {
    const d = decide(view({ ...slowBase, streams: false, waitedMs: 16_000 }));
    expect(d.note).toBe(`${WAIT} · この環境では訳がまとめて届きます`);
  });

  it('keeps only the buffered sentence when not yet slow', () => {
    const d = decide(view({ ...slowBase, streams: false, waitedMs: 1_000 }));
    expect(d.note).toBe('この環境では訳がまとめて届きます');
  });
});

describe('S4 lines arriving', () => {
  it('starts as soon as the preface is in (hide and 設定 appear)', () => {
    expectDecision(decide(view({ running: 'here', hasPreface: true })), {
      state: 'S4',
      status: '',
      actions: [STOP, HIDE, SETTINGS],
      preface: true,
      lines: WRITING,
    });
  });

  it('starts as soon as one line is in, even without a preface', () => {
    expectDecision(decide(view({ running: 'here', done: 1 })), {
      state: 'S4',
      status: '',
      actions: [STOP, HIDE, SETTINGS],
      preface: false,
      lines: WRITING,
    });
  });

  it('shows 訳を表示 when hidden, and the buffered note when the transport does not stream', () => {
    expectDecision(decide(view({ running: 'here', done: 5, hasPreface: true, hidden: true, streams: false })), {
      state: 'S4',
      status: '',
      note: 'この環境では訳がまとめて届きます',
      actions: [STOP, SHOW, SETTINGS],
      preface: true,
      lines: WRITING,
    });
  });
});

describe('S4m another tab is writing this song', () => {
  it('follows it and can ask the owner to stop', () => {
    expectDecision(decide(view({ mirrored: true })), {
      state: 'S4m',
      status: '別のタブで訳しています',
      actions: [{ id: 'stopMirror', label: '止める' }, HIDE],
      preface: false,
      lines: WRITING,
    });
  });

  it('carries the preface, the hide label, and no buffered note', () => {
    expectDecision(decide(view({ mirrored: true, done: 12, hasPreface: true, hidden: true, streams: false })), {
      state: 'S4m',
      status: '別のタブで訳しています',
      actions: [{ id: 'stopMirror', label: '止める' }, SHOW],
      preface: true,
      lines: WRITING,
    });
  });

  it('applies even before any key or line (it is the other tab that is working)', () => {
    expect(decide(view({ mirrored: true, hasKey: false })).state).toBe('S4m');
  });
});

describe('S8 retranslating', () => {
  it('keeps the old edition and offers only 止める', () => {
    expectDecision(decide(view({ running: 'here-retranslate', done: 40 })), {
      state: 'S8',
      status: '訳し直しています · 終わるまで今の訳を表示します',
      actions: [STOP],
      preface: false,
      lines: NONE,
    });
  });

  it('carries the preface of the edition on screen', () => {
    expect(decide(view({ running: 'here-retranslate', done: 40, hasPreface: true })).preface).toBe(true);
  });
});

/* ---------- complete / gaps / lyrics changed ---------- */

describe('S5 complete', () => {
  it('offers hide and 設定', () => {
    expectDecision(decide(view({ done: 40 })), { state: 'S5', status: '', actions: [HIDE, SETTINGS], preface: false, lines: NONE });
  });

  it('shows 訳を表示 when hidden and carries the preface', () => {
    expectDecision(decide(view({ done: 40, hidden: true, hasPreface: true })), { state: 'S5', status: '', actions: [SHOW, SETTINGS], preface: true, lines: NONE });
  });

  it('is not disturbed by a stale stop, a busy quota or another song', () => {
    for (const over of [{ stop: stopOf('gaps') }, { stop: stopOf('quota', { until: SOON }) }, { otherSong: 'X' }, { avail: { ok: false, until: SOON } }]) {
      expect(decide(view({ done: 40, ...over })).state).toBe('S5');
    }
  });
});

describe('S5g complete with gaps', () => {
  const resume = (extra: Partial<ActionSpec> = {}): ActionSpec => ({ id: 'resume', label: '抜けた行を訳す', primary: true, disabled: false, ...extra });
  const gaps = (over: Partial<ViewInput> = {}) => decide(view({ done: 25, stop: stopOf('gaps'), ...over }));
  const GAP_LINES = { slots: false, gaps: true, breathing: false, seam: null };

  it('counts the missing lines and offers the gap fill', () => {
    expectDecision(gaps(), {
      state: 'S5g',
      status: '15行が訳せていません',
      actions: [resume(), HIDE, SETTINGS],
      preface: false,
      lines: GAP_LINES,
    });
  });

  it('carries the preface and 訳を表示 when hidden', () => {
    expectDecision(gaps({ hasPreface: true, hidden: true }), {
      state: 'S5g',
      status: '15行が訳せていません',
      actions: [resume(), SHOW, SETTINGS],
      preface: true,
      lines: GAP_LINES,
    });
  });

  it('another song running: a note and a disabled button', () => {
    expectDecision(gaps({ otherSong: 'X' }), {
      state: 'S5g',
      status: '15行が訳せていません',
      note: BLOCKED_BY_OTHER,
      actions: [resume({ disabled: true }), HIDE, SETTINGS],
      preface: false,
      lines: GAP_LINES,
    });
  });

  it('quota spent: the reset time as the note, button disabled', () => {
    expectDecision(gaps({ avail: { ok: false, until: SOON } }), {
      state: 'S5g',
      status: '15行が訳せていません',
      note: '今日の無料枠は終わりました。15:00から訳せます',
      actions: [resume({ disabled: true }), HIDE, SETTINGS],
      preface: false,
      lines: GAP_LINES,
    });
  });

  it('quota with an unknown reset says あとで', () => {
    expect(gaps({ avail: { ok: false, until: 0 } }).note).toBe('今日の無料枠は終わりました。あとで訳せます');
  });
});

describe('S7 Genius changed the lyrics', () => {
  const resume = (extra: Partial<ActionSpec> = {}): ActionSpec => ({ id: 'resume', label: '新しい行を訳す', primary: true, disabled: false, ...extra });
  const NEW_LINES = { slots: true, gaps: false, breathing: false, seam: null };

  it('says how many lines are new and offers 新しい行を訳す', () => {
    expectDecision(decide(view({ done: 25 })), {
      state: 'S7',
      status: '歌詞が更新され、まだ訳していない行が15行あります',
      actions: [resume(), HIDE, SETTINGS],
      preface: false,
      lines: NEW_LINES,
    });
  });

  it('carries the preface and 訳を表示 when hidden', () => {
    const d = decide(view({ done: 39, hasPreface: true, hidden: true }));
    expectDecision(d, {
      state: 'S7',
      status: '歌詞が更新され、まだ訳していない行が1行あります',
      actions: [resume(), SHOW, SETTINGS],
      preface: true,
      lines: NEW_LINES,
    });
  });

  it('another song running: note + disabled button', () => {
    expectDecision(decide(view({ done: 25, otherSong: 'X' })), {
      state: 'S7',
      status: '歌詞が更新され、まだ訳していない行が15行あります',
      note: BLOCKED_BY_OTHER,
      actions: [resume({ disabled: true }), HIDE, SETTINGS],
      preface: false,
      lines: NEW_LINES,
    });
  });

  it('quota spent: reset time note + disabled button', () => {
    expectDecision(decide(view({ done: 25, avail: { ok: false, until: TOMORROW } })), {
      state: 'S7',
      status: '歌詞が更新され、まだ訳していない行が15行あります',
      note: '今日の無料枠は終わりました。明日 01:00から訳せます',
      actions: [resume({ disabled: true }), HIDE, SETTINGS],
      preface: false,
      lines: NEW_LINES,
    });
  });

  it('a stop that no longer applies turns into S6 "ここまで訳してあります", not S7', () => {
    const d = decide(view({ done: 25, stop: stopOf('auth'), keyBad: false }));
    expect(d.state).toBe('S6');
    expect(d.lines.seam?.text).toBe('ここまで訳してあります');
  });
});

/* ---------- S6 interrupted ---------- */

describe('S6 interrupted', () => {
  const RESUME: ActionSpec = { id: 'resume', label: '続きを訳す', disabled: false };
  const RESUME_WAITING: ActionSpec = { id: 'resume', label: '続きを訳す', disabled: true };
  const NOOP: ActionSpec = { id: 'noop', label: '続きを訳す', disabled: true };
  const OPEN_SETTINGS: ActionSpec = { id: 'settings', label: '設定を開く' };

  interface Row {
    name: string;
    stop: StopInfo;
    over?: Partial<ViewInput>;
    seam: SeamSpec;
    /** With 訳を隠す on, the head says it because the seam button cannot just be pressed. */
    explainWhenHidden: boolean;
  }

  const rows: Row[] = [
    // one request per reason, no blocker
    { name: 'busy', stop: stopOf('busy'), seam: { text: 'AIが混み合っていて、ここで途切れました。少しおいてから続きを訳せます', button: RESUME }, explainWhenHidden: false },
    { name: 'rate before until: waiting button', stop: stopOf('rate', { until: MINUTE_LATER }), seam: { text: 'AIの回数制限にかかりました。1分ほどおいてから続きを訳せます', button: RESUME_WAITING }, explainWhenHidden: true },
    { name: 'rate one ms before until', stop: stopOf('rate', { until: MINUTE_LATER }), over: { now: MINUTE_LATER - 1 }, seam: { text: 'AIの回数制限にかかりました。1分ほどおいてから続きを訳せます', button: RESUME_WAITING }, explainWhenHidden: true },
    { name: 'rate without until', stop: stopOf('rate'), seam: { text: 'AIの回数制限にかかりました。1分ほどおいてから続きを訳せます', button: RESUME }, explainWhenHidden: false },
    { name: 'rate at until reads as closed', stop: stopOf('rate', { until: MINUTE_LATER }), over: { now: MINUTE_LATER }, seam: { text: 'ここまで訳してあります', button: RESUME }, explainWhenHidden: false },
    { name: 'rate past until reads as closed', stop: stopOf('rate', { until: NOW - 1 }), seam: { text: 'ここまで訳してあります', button: RESUME }, explainWhenHidden: false },
    { name: 'quota', stop: stopOf('quota', { until: SOON }), over: { avail: { ok: false, until: SOON } }, seam: { text: '今日の無料枠が終わりました。15:00ごろから続きを訳せます', button: RESUME_WAITING }, explainWhenHidden: true },
    { name: 'quota, reset tomorrow', stop: stopOf('quota', { until: TOMORROW }), over: { avail: { ok: false, until: TOMORROW } }, seam: { text: '今日の無料枠が終わりました。明日 01:00ごろから続きを訳せます', button: RESUME_WAITING }, explainWhenHidden: true },
    { name: 'quota, no known reset', stop: stopOf('quota'), over: { avail: { ok: false, until: 0 } }, seam: { text: '今日の無料枠が終わりました。あとで続きを訳せます', button: RESUME_WAITING }, explainWhenHidden: true },
    { name: 'quota that is available again reads as closed', stop: stopOf('quota', { until: SOON }), over: { avail: { ok: true, until: 0 } }, seam: { text: 'ここまで訳してあります', button: RESUME }, explainWhenHidden: false },
    { name: 'auth with a rejected key: 設定を開く', stop: stopOf('auth'), over: { keyBad: true }, seam: { text: 'APIキーが使えなくなりました。設定でキーを入れ直してください', button: OPEN_SETTINGS }, explainWhenHidden: true },
    { name: 'auth, key not rejected any more, reads as closed', stop: stopOf('auth'), over: { keyBad: false }, seam: { text: 'ここまで訳してあります', button: RESUME }, explainWhenHidden: false },
    { name: 'blocked', stop: stopOf('blocked'), seam: { text: 'この先はAIの安全フィルタで止められました。もう一度試すと通ることがあります', button: RESUME }, explainWhenHidden: false },
    { name: 'network, online', stop: stopOf('network'), over: { online: true }, seam: { text: '接続が切れました。つながったら続きを訳せます', button: RESUME }, explainWhenHidden: false },
    { name: 'network, offline: waiting button', stop: stopOf('network'), over: { online: false }, seam: { text: '接続が切れました。つながったら続きを訳せます', button: RESUME_WAITING }, explainWhenHidden: true },
    { name: 'rejected', stop: stopOf('rejected'), seam: { text: 'AIがこの依頼を受け付けず、ここで途切れました。もう一度試すと別のモデルで訳せることがあります', button: RESUME }, explainWhenHidden: false },
    { name: 'no-model', stop: stopOf('no-model'), seam: { text: '使えるAIのモデルが見つかりませんでした。少しおいてから続きを訳せます', button: RESUME }, explainWhenHidden: false },
    { name: 'empty', stop: stopOf('empty'), seam: { text: 'AIの返事が空のまま、ここで途切れました。もう一度試せます', button: RESUME }, explainWhenHidden: false },
    { name: 'unusable', stop: stopOf('unusable'), seam: { text: 'AIの返事をうまく読み取れず、ここで途切れました。もう一度試せます', button: RESUME }, explainWhenHidden: false },
    { name: 'stopped', stop: stopOf('stopped'), seam: { text: 'ここで止めました', button: RESUME }, explainWhenHidden: false },
    { name: 'length', stop: stopOf('length'), seam: { text: '長い曲なので、ここで一度区切りました', button: RESUME }, explainWhenHidden: false },
    { name: 'closed', stop: stopOf('closed'), seam: { text: 'ここまで訳してあります', button: RESUME }, explainWhenHidden: false },
    // blockers
    { name: 'another song running, busy: blocker said in the seam, noop button', stop: stopOf('busy'), over: { otherSong: 'X' }, seam: { text: 'AIが混み合っていて、ここで途切れました。別の曲を訳し終えると続きを訳せます', button: NOOP }, explainWhenHidden: true },
    { name: 'another song running, rate', stop: stopOf('rate', { until: MINUTE_LATER }), over: { otherSong: 'X' }, seam: { text: 'AIの回数制限にかかりました。別の曲を訳し終えると続きを訳せます', button: NOOP }, explainWhenHidden: true },
    { name: 'another song running, network', stop: stopOf('network'), over: { otherSong: 'X' }, seam: { text: '接続が切れました。別の曲を訳し終えると続きを訳せます', button: NOOP }, explainWhenHidden: true },
    { name: 'another song running, stopped', stop: stopOf('stopped'), over: { otherSong: 'X' }, seam: { text: 'ここで止めました。別の曲を訳し終えると続きを訳せます', button: NOOP }, explainWhenHidden: true },
    { name: 'another song running, closed', stop: stopOf('closed'), over: { otherSong: 'X' }, seam: { text: 'ここまで訳してあります。別の曲を訳し終えると続きを訳せます', button: NOOP }, explainWhenHidden: true },
    { name: 'another song running, quota: the quota sentence already says it', stop: stopOf('quota', { until: SOON }), over: { otherSong: 'X', avail: { ok: false, until: SOON } }, seam: { text: '今日の無料枠が終わりました。15:00ごろから続きを訳せます', button: RESUME_WAITING }, explainWhenHidden: true },
    { name: 'another song running, auth: settings still wins', stop: stopOf('auth'), over: { otherSong: 'X', keyBad: true }, seam: { text: 'APIキーが使えなくなりました。設定でキーを入れ直してください', button: OPEN_SETTINGS }, explainWhenHidden: true },
    { name: 'quota spent, stopped: blocker appended, noop button', stop: stopOf('stopped'), over: { avail: { ok: false, until: SOON } }, seam: { text: 'ここで止めました。今日の無料枠は終わりました。15:00から訳せます', button: NOOP }, explainWhenHidden: true },
    { name: 'quota spent, busy', stop: stopOf('busy'), over: { avail: { ok: false, until: SOON } }, seam: { text: 'AIが混み合っていて、ここで途切れました。今日の無料枠は終わりました。15:00から訳せます', button: NOOP }, explainWhenHidden: true },
    { name: 'quota spent with unknown reset, closed', stop: stopOf('closed'), over: { avail: { ok: false, until: 0 } }, seam: { text: 'ここまで訳してあります。今日の無料枠は終わりました。あとで訳せます', button: NOOP }, explainWhenHidden: true },
    { name: 'quota stop whose own reset passed while still exhausted reads as closed + blocker', stop: stopOf('quota', { until: NOW - 1 }), over: { avail: { ok: false, until: SOON } }, seam: { text: 'ここまで訳してあります。今日の無料枠は終わりました。15:00から訳せます', button: NOOP }, explainWhenHidden: true },
  ];

  const settingsLike = (seam: SeamSpec) => seam.button.id === 'settings';
  const expected = (row: Row, hidden: boolean, preface = false): Decision => ({
    state: 'S6',
    status: '途中まで訳してあります（10/40行）',
    ...(hidden && row.explainWhenHidden ? { note: row.seam.text } : {}),
    actions: [{ ...row.seam.button, primary: true }, hidden ? SHOW : HIDE, ...(settingsLike(row.seam) ? [] : [SETTINGS])],
    preface,
    lines: { slots: true, gaps: false, breathing: false, seam: row.seam },
  });
  const run = (row: Row, over: Partial<ViewInput> = {}) => decide(view({ done: 10, stop: row.stop, ...row.over, ...over }));

  it.each(rows)('$name', (row) => {
    expectDecision(run(row), expected(row, false));
  });

  it.each(rows)('hidden: $name', (row) => {
    expectDecision(run(row, { hidden: true }), expected(row, true));
  });

  it('keeps the preface of the edition on screen', () => {
    const row = rows[0]!;
    expectDecision(run(row, { hasPreface: true }), expected(row, false, true));
  });

  it('the seam (lines) and the first action describe the same button; only the action is primary', () => {
    for (const row of rows) {
      const d = run(row);
      expect(d.lines.seam).toEqual(row.seam);
      expect(d.lines.seam?.button).not.toHaveProperty('primary');
      expect(d.actions[0]).toEqual({ ...d.lines.seam!.button, primary: true });
    }
  });

  it('auth: 設定を開く replaces 設定 (no second settings button)', () => {
    const d = decide(view({ done: 10, stop: stopOf('auth'), keyBad: true }));
    expect(d.actions.map((a) => a.id)).toEqual(['settings', 'hide']);
    expect(d.actions.map((a) => a.label)).toEqual(['設定を開く', '訳を隠す']);
  });

  it('every other reason keeps 設定 as the last action', () => {
    for (const row of rows.filter((r) => !settingsLike(r.seam))) {
      expect(run(row).actions.at(-1)).toEqual(SETTINGS);
    }
  });

  it('the status counts lines, not translations', () => {
    expect(decide(view({ done: 1, total: 2, stop: stopOf('busy') })).status).toBe('途中まで訳してあります（1/2行）');
  });

  it('a gaps stop with lines still missing is S5g, not S6', () => {
    expect(decide(view({ done: 10, stop: stopOf('gaps') })).state).toBe('S5g');
  });

  it('no stop at all is S7, not S6', () => {
    expect(decide(view({ done: 10 })).state).toBe('S7');
  });

  describe('with 訳を隠す on', () => {
    it('stays quiet when the seam button can simply be pressed', () => {
      const d = decide(view({ done: 10, hidden: true, stop: stopOf('busy') }));
      expect(d.state).toBe('S6');
      expect(d).not.toHaveProperty('note');
      expect(d.actions).toEqual([{ id: 'resume', label: '続きを訳す', disabled: false, primary: true }, SHOW, SETTINGS]);
    });

    it('a blocked/closed/stopped/length seam that works says nothing either', () => {
      for (const reason of ['blocked', 'closed', 'stopped', 'length', 'unusable'] as const) {
        expect(decide(view({ done: 10, hidden: true, stop: stopOf(reason) }))).not.toHaveProperty('note');
      }
    });

    it('never adds a note when 訳を隠す is off, whatever blocks the button', () => {
      for (const row of rows) expect(run(row, { hidden: false })).not.toHaveProperty('note');
    });

    it('the note is the seam sentence verbatim', () => {
      const d = decide(view({ done: 10, hidden: true, stop: stopOf('busy'), otherSong: 'X' }));
      expect(d.note).toBe('AIが混み合っていて、ここで途切れました。別の曲を訳し終えると続きを訳せます');
      expect(d.note).toBe(d.lines.seam?.text);
    });
  });
});

/* ---------- S8f ---------- */

describe('S8f retranslation failed', () => {
  const notice = { status: '訳し直しは途中で止まりました。今の訳はそのままです', detail: 'AIの回数制限にかかりました。1分ほどおいてから試せます' };

  it('shows the notice with its detail as the note', () => {
    expectDecision(decide(view({ done: 25, notice })), {
      state: 'S8f',
      status: notice.status,
      note: notice.detail,
      actions: [HIDE, SETTINGS],
      preface: false,
      lines: NONE,
    });
  });

  it('has no note when the notice has no detail', () => {
    expectDecision(decide(view({ done: 25, notice: { status: '訳し直せませんでした。今の訳はそのままです', detail: '' } })), {
      state: 'S8f',
      status: '訳し直せませんでした。今の訳はそのままです',
      actions: [HIDE, SETTINGS],
      preface: false,
      lines: NONE,
    });
  });

  it('applies to a finished song as well (the case it exists for), keeping preface and 訳を表示', () => {
    expectDecision(decide(view({ done: 40, hasPreface: true, hidden: true, notice })), {
      state: 'S8f',
      status: notice.status,
      note: notice.detail,
      actions: [SHOW, SETTINGS],
      preface: true,
      lines: NONE,
    });
  });

  it('beats S5, S5g, S6 and S7', () => {
    for (const over of [{ done: 40 }, { done: 20, stop: stopOf('gaps') }, { done: 20, stop: stopOf('busy') }, { done: 20 }]) {
      expect(decide(view({ ...over, notice })).state).toBe('S8f');
    }
  });

  it('is ignored when nothing is translated', () => {
    expect(decide(view({ done: 0, notice })).state).toBe('S2');
    expect(decide(view({ done: 0, hasKey: false, notice })).state).toBe('S1');
  });
});

/* ---------- priorities ---------- */

describe('priorities', () => {
  const notice = { status: 's', detail: 'd' };

  it('retranslating here beats a mirror, a notice and everything below', () => {
    expect(decide(view({ running: 'here-retranslate', mirrored: true, notice, done: 40, hasKey: false })).state).toBe('S8');
  });

  it('running here beats mirrored', () => {
    expect(decide(view({ running: 'here', mirrored: true })).state).toBe('S3');
    expect(decide(view({ running: 'here', mirrored: true, done: 3 })).state).toBe('S4');
  });

  it('running here beats a notice', () => {
    expect(decide(view({ running: 'here', notice, done: 3 })).state).toBe('S4');
  });

  it('mirrored beats a notice', () => {
    expect(decide(view({ mirrored: true, notice, done: 3 })).state).toBe('S4m');
  });

  it('a notice only counts once something is translated', () => {
    expect(decide(view({ notice, done: 0 })).state).toBe('S2');
    expect(decide(view({ notice, done: 1 })).state).toBe('S8f');
  });

  it('running here beats the other-song and quota states', () => {
    expect(decide(view({ running: 'here', otherSong: 'X', avail: { ok: false, until: SOON } })).state).toBe('S3');
  });
});

/* ---------- liveStop ---------- */

describe('liveStop', () => {
  it('passes undefined through', () => {
    expect(liveStop(undefined, view())).toBeUndefined();
  });

  it('auth: closed unless a key is known to be rejected', () => {
    const stop = stopOf('auth');
    expect(liveStop(stop, view({ keyBad: false }))).toEqual({ reason: 'closed', at: stop.at });
    expect(liveStop(stop, view({ keyBad: true }))).toBe(stop);
  });

  it('quota: closed once any model is available again', () => {
    const stop = stopOf('quota', { until: SOON });
    expect(liveStop(stop, view({ avail: { ok: true, until: 0 } }))).toEqual({ reason: 'closed', at: stop.at });
    expect(liveStop(stop, view({ avail: { ok: false, until: SOON } }))).toBe(stop);
  });

  it('quota and rate: closed once `until` has passed (inclusive of now)', () => {
    for (const reason of ['quota', 'rate'] as const) {
      const stop = stopOf(reason, { until: SOON });
      const exhausted = { avail: { ok: false, until: SOON } };
      expect(liveStop(stop, view({ now: SOON - 1, ...exhausted }))).toBe(stop);
      expect(liveStop(stop, view({ now: SOON, ...exhausted }))).toEqual({ reason: 'closed', at: stop.at });
      expect(liveStop(stop, view({ now: SOON + 1, ...exhausted }))).toEqual({ reason: 'closed', at: stop.at });
    }
  });

  it('quota and rate without an until never expire by time', () => {
    expect(liveStop(stopOf('rate'), view({ now: NOW + 99 * HOUR }))).toEqual(stopOf('rate'));
    const quota = stopOf('quota');
    expect(liveStop(quota, view({ now: NOW + 99 * HOUR, avail: { ok: false, until: 0 } }))).toBe(quota);
  });

  it('a rate stop is not closed by availability', () => {
    const stop = stopOf('rate', { until: SOON });
    expect(liveStop(stop, view({ avail: { ok: true, until: 0 } }))).toBe(stop);
  });

  it('the closed replacement keeps `at` and drops `until`', () => {
    const stop = stopOf('rate', { until: NOW - 1 });
    const closed = liveStop(stop, view());
    expect(closed).toEqual({ reason: 'closed', at: stop.at });
    expect(closed).not.toHaveProperty('until');
  });

  it.each<StopReason>(['busy', 'blocked', 'network', 'rejected', 'no-model', 'empty', 'unusable', 'stopped', 'length', 'closed', 'gaps'])('leaves %s alone', (reason) => {
    const stop = stopOf(reason, { until: NOW - 1 });
    expect(liveStop(stop, view({ keyBad: false, avail: { ok: true, until: 0 } }))).toBe(stop);
  });
});

/* ---------- sentences ---------- */

describe('seamText', () => {
  const i = view();
  const fixed: Array<[StopReason, string]> = [
    ['busy', 'AIが混み合っていて、ここで途切れました。少しおいてから続きを訳せます'],
    ['rate', 'AIの回数制限にかかりました。1分ほどおいてから続きを訳せます'],
    ['auth', 'APIキーが使えなくなりました。設定でキーを入れ直してください'],
    ['network', '接続が切れました。つながったら続きを訳せます'],
    ['rejected', 'AIがこの依頼を受け付けず、ここで途切れました。もう一度試すと別のモデルで訳せることがあります'],
    ['no-model', '使えるAIのモデルが見つかりませんでした。少しおいてから続きを訳せます'],
    ['empty', 'AIの返事が空のまま、ここで途切れました。もう一度試せます'],
    ['unusable', 'AIの返事をうまく読み取れず、ここで途切れました。もう一度試せます'],
    ['stopped', 'ここで止めました'],
    ['length', '長い曲なので、ここで一度区切りました'],
    ['closed', 'ここまで訳してあります'],
    ['gaps', 'ここまで訳してあります'],
  ];

  it.each(fixed)('%s', (reason, text) => {
    expect(seamText(stopOf(reason), i)).toBe(text);
  });

  it('quota with a future reset names the time', () => {
    expect(seamText(stopOf('quota', { until: SOON }), i)).toBe(`今日の無料枠が終わりました。${at(SOON)}ごろから続きを訳せます`);
    expect(seamText(stopOf('quota', { until: TOMORROW }), i)).toBe(`今日の無料枠が終わりました。${at(TOMORROW)}ごろから続きを訳せます`);
  });

  it.each([
    ['no until', undefined],
    ['until 0', 0],
    ['until in the past', NOW - 1],
    ['until exactly now', NOW],
  ])('quota with %s says あとで', (_name, until) => {
    expect(seamText(stopOf('quota', until === undefined ? {} : { until }), i)).toBe('今日の無料枠が終わりました。あとで続きを訳せます');
  });

  it('blocked says to try again', () => {
    expect(seamText(stopOf('blocked'), view())).toBe('この先はAIの安全フィルタで止められました。もう一度試すと通ることがあります');
  });

  it('measures the reset against the input clock', () => {
    expect(seamText(stopOf('quota', { until: SOON }), view({ now: SOON }))).toBe('今日の無料枠が終わりました。あとで続きを訳せます');
  });
});

describe('startFailText', () => {
  const i = view();

  it.each<[StopReason, string]>([
    ['busy', 'AIが混み合っていて、訳し始められませんでした。少しおいてからもう一度どうぞ'],
    ['rate', 'AIの回数制限にかかりました。1分ほどおいてから訳せます'],
    ['auth', 'APIキーが使えなくなりました。設定でキーを入れ直してください'],
    ['network', '接続が切れて、訳し始められませんでした。つながったら訳せます'],
    ['rejected', 'AIがこの依頼を受け付けませんでした。もう一度試すと別のモデルで訳せることがあります'],
    ['no-model', '使えるAIのモデルが見つかりませんでした。少しおいてからもう一度どうぞ'],
    ['empty', 'AIから空の返事が返ってきました。もう一度試せます'],
    ['unusable', 'AIの返事をうまく読み取れませんでした。もう一度試せます'],
    ['length', '長い曲なので、一度では訳し切れませんでした'],
  ])('%s', (reason, text) => {
    expect(startFailText(stopOf(reason), i)).toBe(text);
  });

  it('quota names the reset time or says あとで', () => {
    expect(startFailText(stopOf('quota', { until: SOON }), i)).toBe(`今日の無料枠が終わりました。${at(SOON)}ごろから訳せます`);
    expect(startFailText(stopOf('quota', { until: TOMORROW }), i)).toBe('今日の無料枠が終わりました。明日 01:00ごろから訳せます');
    expect(startFailText(stopOf('quota'), i)).toBe('今日の無料枠が終わりました。あとで訳せます');
    expect(startFailText(stopOf('quota', { until: NOW - 1 }), i)).toBe('今日の無料枠が終わりました。あとで訳せます');
  });

  it('blocked says to try again', () => {
    expect(startFailText(stopOf('blocked'), view())).toBe('この曲はAIの安全フィルタで止められました。もう一度試すと通ることがあります');
  });

  it.each<StopReason>(['stopped', 'closed', 'gaps'])('%s has no start-failure sentence (empty)', (reason) => {
    expect(startFailText(stopOf(reason), i)).toBe('');
  });

  it('never mentions "ここ" or 続き (nothing is on the page yet)', () => {
    const reasons: StopReason[] = ['busy', 'rate', 'quota', 'auth', 'blocked', 'network', 'rejected', 'no-model', 'empty', 'unusable', 'length'];
    for (const reason of reasons) {
      const text = startFailText(stopOf(reason, { until: SOON }), view());
      expect(text).not.toMatch(/ここ|続き/);
    }
  });
});

describe('failureText', () => {
  it.each<[StopReason, string]>([
    ['busy', '混み合っていました。少しおいてから試せます'],
    ['rate', 'AIの回数制限にかかりました。1分ほどおいてから試せます'],
    ['auth', 'APIキーが使えなくなりました。設定でキーを入れ直してください'],
    ['blocked', 'AIの安全フィルタで止められました'],
    ['network', '接続が切れました'],
    ['rejected', 'AIが依頼を受け付けませんでした'],
    ['no-model', '使えるモデルが見つかりませんでした'],
    ['empty', 'AIの返事が空でした'],
    ['unusable', 'AIの返事をうまく読み取れませんでした'],
    ['stopped', '止めました'],
    ['length', '長い曲なので、一度では訳し切れませんでした'],
    ['closed', '返事が途中で途切れました'],
    ['gaps', '訳せない行が残りました'],
  ])('%s', (reason, text) => {
    expect(failureText(stopOf(reason), NOW)).toBe(text);
  });

  it('quota puts the reset time in parentheses, or nothing', () => {
    expect(failureText(stopOf('quota', { until: SOON }), NOW)).toBe(`今日の無料枠が終わりました（${at(SOON)}に戻ります）`);
    expect(failureText(stopOf('quota', { until: TOMORROW }), NOW)).toBe('今日の無料枠が終わりました（明日 01:00に戻ります）');
    expect(failureText(stopOf('quota'), NOW)).toBe('今日の無料枠が終わりました');
    expect(failureText(stopOf('quota', { until: NOW - 1 }), NOW)).toBe('今日の無料枠が終わりました');
  });

  it('never promises a 続き (S8f offers none)', () => {
    const reasons: StopReason[] = ['busy', 'rate', 'quota', 'auth', 'blocked', 'network', 'rejected', 'no-model', 'empty', 'unusable', 'stopped', 'length', 'closed', 'gaps'];
    for (const reason of reasons) expect(failureText(stopOf(reason, { until: SOON }), NOW)).not.toContain('続き');
  });
});

describe('seamFor', () => {
  const i = view();
  const BUSY = 'AIが混み合っていて、ここで途切れました。少しおいてから続きを訳せます';

  it('no blocker: a plain, enabled 続きを訳す', () => {
    expect(seamFor(stopOf('busy'), i, null)).toEqual({ text: BUSY, button: { id: 'resume', label: '続きを訳す', disabled: false } });
  });

  it('auth always opens the settings, ignoring blockers', () => {
    const text = 'APIキーが使えなくなりました。設定でキーを入れ直してください';
    const expected = { text, button: { id: 'settings', label: '設定を開く' } };
    expect(seamFor(stopOf('auth'), i, null)).toEqual(expected);
    expect(seamFor(stopOf('auth'), i, 'B')).toEqual(expected);
  });

  it('a blocker on a non-quota reason is appended after the first sentence and the button is a disabled noop', () => {
    expect(seamFor(stopOf('busy'), i, 'BLOCK')).toEqual({
      text: 'AIが混み合っていて、ここで途切れました。BLOCK',
      button: { id: 'noop', label: '続きを訳す', disabled: true },
    });
  });

  it('a blocker without a hint on quota: the quota sentence, a disabled resume (not noop)', () => {
    expect(seamFor(stopOf('quota', { until: SOON }), i, 'BLOCK')).toEqual({
      text: `今日の無料枠が終わりました。${at(SOON)}ごろから続きを訳せます`,
      button: { id: 'resume', label: '続きを訳す', disabled: true },
    });
  });

  it('rate waits until `until` (strictly before it)', () => {
    const stop = stopOf('rate', { until: MINUTE_LATER });
    expect(seamFor(stop, view({ now: NOW }), null).button.disabled).toBe(true);
    expect(seamFor(stop, view({ now: MINUTE_LATER - 1 }), null).button.disabled).toBe(true);
    expect(seamFor(stop, view({ now: MINUTE_LATER }), null).button.disabled).toBe(false);
    expect(seamFor(stopOf('rate'), i, null).button.disabled).toBe(false);
  });

  it('network waits for the connection', () => {
    expect(seamFor(stopOf('network'), view({ online: false }), null).button.disabled).toBe(true);
    expect(seamFor(stopOf('network'), view({ online: true }), null).button.disabled).toBe(false);
  });

  it('offline does not matter for other reasons', () => {
    expect(seamFor(stopOf('busy'), view({ online: false }), null).button.disabled).toBe(false);
  });
});
