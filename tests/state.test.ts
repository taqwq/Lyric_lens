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
const FIRST_RUN: ActionSpec = { id: 'firstRun', label: '日本語で読む', primary: true };
const NONE = { slots: false, gaps: false, breathing: false, seam: null };
const WRITING = { slots: true, gaps: false, breathing: true, seam: null };

const BLOCKED_BY_OTHER = '別の曲を訳し終えると、この曲も訳せます';
const quotaBlocker = (until: number) => `今日の無料枠を使い切りました。${at(until)}から訳せます`;

/** A Decision with the quiet defaults filled in (count is absent unless given). */
const D = (over: Partial<Decision> & Pick<Decision, 'state'>): Decision => ({
  tone: 'speaking', status: '', captions: [], progress: null, actions: [], preface: false, lines: NONE, ...over,
});

/** toEqual ignores undefined properties; this also fails on a stray `count: undefined`. */
function expectDecision(actual: Decision, expected: Decision): void {
  expect(actual).toEqual(expected);
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
}

/* ---------- S1 / S2 family: nothing translated yet ---------- */

describe('S1 no key', () => {
  it('asks for the key in a caption, behind one primary button', () => {
    expectDecision(decide(view({ hasKey: false })), D({
      state: 'S1',
      captions: [{ text: '最初に一度だけ、無料のAPIキーを設定します' }],
      actions: [FIRST_RUN],
    }));
  });

  it('ignores a preface and the hide switch, and never counts', () => {
    const d = decide(view({ hasKey: false, hasPreface: true, hidden: true }));
    expect(d.state).toBe('S1');
    expect(d.preface).toBe(false);
    expect(d.actions).toEqual([FIRST_RUN]);
    expect(d.count).toBeUndefined();
  });

  it('beats the other-song and quota states', () => {
    expect(decide(view({ hasKey: false, otherSong: 'X', avail: { ok: false, until: SOON } })).state).toBe('S1');
  });
});

describe('S2 ready', () => {
  it('offers 日本語で読む and 設定 with nothing to say', () => {
    expectDecision(decide(view()), D({ state: 'S2', actions: [START, SETTINGS] }));
  });

  it('ignores a preface and the hide switch before anything is written', () => {
    const d = decide(view({ hasPreface: true, hidden: true }));
    expect(d.state).toBe('S2');
    expect(d.preface).toBe(false);
    expect(d.actions).toEqual([START, SETTINGS]);
  });

  const plain: Array<[string, Partial<ViewInput>]> = [
    ['stopped by the reader', { stop: stopOf('stopped') }],
    ['closed tab', { stop: stopOf('closed') }],
    ['rate limit whose wait is over', { stop: stopOf('rate', { until: NOW - 1 }) }],
    ['rate limit that ends exactly now', { stop: stopOf('rate', { until: NOW }) }],
    ['daily quota that is available again', { stop: stopOf('quota', { until: SOON }), avail: { ok: true, until: 0 } }],
    ['auth stop but no key is rejected any more', { stop: stopOf('auth'), keyBad: false }],
  ];
  it.each(plain)('stays plain S2 for %s', (_name, over) => {
    expectDecision(decide(view(over)), D({ state: 'S2', actions: [START, SETTINGS] }));
  });
});

describe('SJ Japanese lyrics', () => {
  it('says so quietly (settled) and offers nothing', () => {
    expectDecision(decide(view({ japanese: true })), D({ state: 'SJ', tone: 'settled', status: 'この曲の歌詞は日本語です' }));
  });

  it('needs no key and ignores the other-song and quota states', () => {
    expect(decide(view({ japanese: true, hasKey: false })).state).toBe('SJ');
    expect(decide(view({ japanese: true, otherSong: 'X' })).state).toBe('SJ');
    expect(decide(view({ japanese: true, avail: { ok: false, until: SOON } })).state).toBe('SJ');
  });

  it('is not shown once something is translated', () => {
    expect(decide(view({ japanese: true, done: 5 })).state).toBe('S7');
    expect(decide(view({ japanese: true, done: 40, total: 40 })).state).toBe('S5');
  });
});

describe('S2b another song is being written', () => {
  it('names it in a caption and offers only to stop it', () => {
    expectDecision(decide(view({ otherSong: 'Smoke Signals' })), D({
      state: 'S2b',
      status: '別の曲を訳しています',
      captions: [{ text: '「Smoke Signals」を訳し終えると、この曲も訳せます' }],
      actions: [{ id: 'stopOther', label: 'あちらを止める' }],
    }));
  });

  it('has no 設定 link', () => {
    expect(decide(view({ otherSong: 'X' })).actions.map((a) => a.id)).toEqual(['stopOther']);
  });
});

describe('S2q quota known exhausted', () => {
  it('says the day is used up and when it resets (status + caption), 設定 as the only link', () => {
    expectDecision(decide(view({ avail: { ok: false, until: SOON } })), D({
      state: 'S2q',
      status: '今日の無料枠を使い切りました',
      captions: [{ text: '15:00から、また訳せます' }],
      actions: [SETTINGS],
    }));
  });

  it('says 明日 when the reset is on the next day in Japan', () => {
    expect(decide(view({ avail: { ok: false, until: TOMORROW } })).captions).toEqual([{ text: '明日 1:00から、また訳せます' }]);
  });

  it.each([[0], [NOW - 1], [NOW]])('has no time caption for a reset of %i (unknown or already past)', (until) => {
    const d = decide(view({ avail: { ok: false, until } }));
    expect(d.state).toBe('S2q');
    expect(d.captions).toEqual([]);
  });
});

describe('S2f the first request produced nothing', () => {
  const plain = (extra: Partial<ActionSpec> = {}): ActionSpec => ({ id: 'start', label: 'もう一度訳す', primary: true, disabled: false, ...extra });

  const rows: Array<{ name: string; stop: StopInfo; over?: Partial<ViewInput>; reason: string; button?: Partial<ActionSpec> }> = [
    { name: 'busy', stop: stopOf('busy'), reason: 'AIが混み合っていて、訳し始められませんでした。少しおいてからもう一度試せます' },
    { name: 'rate before until (button waits)', stop: stopOf('rate', { until: MINUTE_LATER }), reason: 'AIの回数制限にかかりました。1分ほどおいてから訳せます', button: { disabled: true } },
    { name: 'rate one ms before until', stop: stopOf('rate', { until: MINUTE_LATER }), over: { now: MINUTE_LATER - 1 }, reason: 'AIの回数制限にかかりました。1分ほどおいてから訳せます', button: { disabled: true } },
    { name: 'rate without a known until', stop: stopOf('rate'), reason: 'AIの回数制限にかかりました。1分ほどおいてから訳せます' },
    { name: 'blocked', stop: stopOf('blocked'), reason: 'この曲はAIの安全フィルタで止められました。もう一度試すと通ることがあります' },
    { name: 'network, online', stop: stopOf('network'), over: { online: true }, reason: '接続が切れて、訳し始められませんでした。つながったら訳せます' },
    { name: 'network, offline (button waits)', stop: stopOf('network'), over: { online: false }, reason: '接続が切れて、訳し始められませんでした。つながったら訳せます', button: { disabled: true } },
    { name: 'silent (two timeouts): enabled, no word about the connection', stop: stopOf('silent'), over: { online: true }, reason: 'AIから返事がなく、訳し始められませんでした。少しおいてからもう一度試せます' },
    { name: 'rate for five minutes names the time (button waits)', stop: stopOf('rate', { until: NOW + 5 * 60_000 }), reason: 'AIの回数制限にかかりました。12:05ごろから訳せます', button: { disabled: true } },
    { name: 'unusable benched for ten minutes names the time (button waits)', stop: stopOf('unusable', { until: NOW + 600_000 }), reason: 'AIの返事をうまく読み取れませんでした。12:10ごろからもう一度試せます', button: { disabled: true } },
    { name: 'rejected', stop: stopOf('rejected'), reason: 'AIへの依頼が通らず、訳し始められませんでした。もう一度試すと通ることがあります' },
    { name: 'no-model', stop: stopOf('no-model'), reason: '今はAIを使えません。少しおいてからもう一度試せます' },
    { name: 'empty', stop: stopOf('empty'), reason: 'AIの返事が空で、訳し始められませんでした。もう一度試せます' },
    { name: 'unusable', stop: stopOf('unusable'), reason: 'AIの返事をうまく読み取れませんでした。もう一度試せます' },
    { name: 'length', stop: stopOf('length'), reason: '長い曲なので、一度では訳し切れませんでした' },
  ];

  it.each(rows)('$name', ({ stop, over, reason, button }) => {
    expectDecision(decide(view({ stop, ...over })), D({
      state: 'S2f',
      captions: [{ text: reason }],
      actions: [plain(button), SETTINGS],
    }));
  });

  it('auth with a rejected key: the button is 設定を開く and there is no second 設定', () => {
    expectDecision(decide(view({ stop: stopOf('auth'), keyBad: true })), D({
      state: 'S2f',
      captions: [{ text: 'APIキーが使えなくなりました。設定でキーを入れ直してください' }],
      actions: [{ id: 'settings', label: '設定を開く', primary: true }],
    }));
  });

  it('the status is empty (the button takes its place) and the reason is a caption, never joined with ·', () => {
    const d = decide(view({ stop: stopOf('busy') }));
    expect(d.status).toBe('');
    expect(d.captions).toHaveLength(1);
    expect(d.captions[0]!.text).not.toContain(' · ');
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
});

/* ---------- writing ---------- */

describe('S3 reading the whole song first', () => {
  it('is just 止める, an indeterminate bar and no count', () => {
    expectDecision(decide(view({ running: 'here' })), D({
      state: 'S3',
      status: '歌詞を読んでいます',
      progress: 'indeterminate',
      actions: [STOP],
      lines: WRITING,
    }));
  });

  it('says answers arrive all at once when the transport buffers', () => {
    expect(decide(view({ running: 'here', streams: false })).captions).toEqual([{ text: 'この環境では訳がまとめて届きます' }]);
  });

  it('says the wait is expected once the first line is 15 s late', () => {
    expect(decide(view({ running: 'here', waitedMs: 15_000 })).captions).toEqual([{ text: 'AIの返事を待っています。混み合っていると1分ほどかかることもあります' }]);
    expect(decide(view({ running: 'here', waitedMs: 14_999 })).captions).toEqual([]);
  });

  it('keeps the wait and buffered sentences as two captions, wait first', () => {
    const d = decide(view({ running: 'here', waitedMs: 20_000, streams: false }));
    expect(d.captions.map((c) => c.text)).toEqual(['AIの返事を待っています。混み合っていると1分ほどかかることもあります', 'この環境では訳がまとめて届きます']);
    expect(d.captions.every((c) => !c.tone)).toBe(true);
  });

  it('is not slow once a line has arrived', () => {
    expect(decide(view({ running: 'here', waitedMs: 60_000, done: 2 })).captions).toEqual([]);
  });
});

describe('S6 a per-minute stop next to a spent daily quota names one limit', () => {
  // The per-minute stop is still live (until ahead): once its own wait has passed it reads as closed.
  const spent = { ok: false, until: NOW + 5 * HOUR } as const;
  const resting = (reason: 'rate' | 'busy') =>
    decide(view({ done: 9, total: 30, stop: { reason, at: NOW - 30_000, until: NOW + 30_000 }, avail: spent }));

  it('rate: ここで途切れました, then the quota; no 回数制限', () => {
    const d = resting('rate');
    expect(d.state).toBe('S6');
    expect(d.lines.seam!.text.startsWith('ここで途切れました。今日の無料枠を使い切りました')).toBe(true);
    expect(d.lines.seam!.text).not.toContain('回数制限');
    expect(d.lines.seam!.button.disabled).toBe(true);
    expect(d.actions[0]).toMatchObject({ disabled: true });
  });

  it('busy: the same', () => {
    expect(resting('busy').lines.seam!.text.startsWith('ここで途切れました。今日の無料枠')).toBe(true);
  });

  it('another song running keeps the reason sentence and the lock blocker', () => {
    const d = decide(view({ done: 9, total: 30, stop: { reason: 'rate', at: NOW - 30_000, until: NOW + 30_000 }, otherSong: 'Midnight Static' }));
    expect(d.lines.seam!.text.startsWith('AIの回数制限にかかりました。別の曲を訳し終えると、この曲も訳せます')).toBe(true);
  });
});

describe('captions: only a reason for a blocked button is tone reason', () => {
  it('the buffered, wait, count and update captions are untoned', () => {
    const buffered = decide(view({ running: 'here', streams: false, done: 3 }));
    expect(buffered.captions).toEqual([{ text: 'この環境では訳がまとめて届きます' }]);
    expect(decide(view({ done: 20 })).captions[0]).toEqual({ text: '歌詞が更新されました。まだ訳していない行が20行あります' });
    expect(decide(view({ done: 10, stop: stopOf('busy') })).captions).toEqual([{ text: '40行のうち10行を訳してあります' }]);
  });

  it('the S8f detail is a reason', () => {
    const d = decide(view({ done: 25, notice: { status: 'x', detail: '止めました' } }));
    expect(d.captions[1]).toEqual({ text: '止めました', tone: 'reason' });
    expect(d.captions[0]).not.toHaveProperty('tone');
  });
});

describe('S4 lines arriving', () => {
  it('starts as soon as the preface is in (hide and 設定 appear), counting from zero', () => {
    expectDecision(decide(view({ running: 'here', hasPreface: true })), D({
      state: 'S4',
      status: '訳しています',
      count: { done: 0, total: 40 },
      progress: { value: 0, max: 40 },
      actions: [STOP, HIDE, SETTINGS],
      preface: true,
      lines: WRITING,
    }));
  });

  it('starts as soon as one line is in, even without a preface; the bar and the count follow done/total', () => {
    expectDecision(decide(view({ running: 'here', done: 12, total: 67 })), D({
      state: 'S4',
      status: '訳しています',
      count: { done: 12, total: 67 },
      progress: { value: 12, max: 67 },
      actions: [STOP, HIDE, SETTINGS],
      lines: WRITING,
    }));
  });

  it('shows 訳を表示 when hidden, and the buffered caption when the transport does not stream', () => {
    const d = decide(view({ running: 'here', done: 3, hidden: true, streams: false }));
    expect(d.actions).toEqual([STOP, SHOW, SETTINGS]);
    expect(d.captions).toEqual([{ text: 'この環境では訳がまとめて届きます' }]);
  });

  it('has no primary button: 止める is a link', () => {
    expect(decide(view({ running: 'here', done: 3 })).actions.some((a) => a.primary)).toBe(false);
  });
});

describe('S4m another tab is writing this song', () => {
  it('follows it and can ask the owner to stop (止める, 訳を隠す; no 設定)', () => {
    expectDecision(decide(view({ mirrored: true, done: 3 })), D({
      state: 'S4m',
      status: '別のタブで訳しています',
      actions: [{ id: 'stopMirror', label: '止める' }, HIDE],
      lines: WRITING,
    }));
  });

  it('carries the preface and the hide label', () => {
    const d = decide(view({ mirrored: true, hasPreface: true, hidden: true }));
    expect(d.preface).toBe(true);
    expect(d.actions).toEqual([{ id: 'stopMirror', label: '止める' }, SHOW]);
  });
});

describe('S8 retranslating', () => {
  it('keeps the old edition and offers only 止める, with an indeterminate bar', () => {
    expectDecision(decide(view({ running: 'here-retranslate', done: 40 })), D({
      state: 'S8',
      status: '訳し直しています',
      captions: [{ text: '訳し終えるまでは、今の訳をそのまま表示します' }],
      progress: 'indeterminate',
      actions: [STOP],
    }));
  });

  it('carries the preface', () => {
    expect(decide(view({ running: 'here-retranslate', done: 40, hasPreface: true })).preface).toBe(true);
  });
});

/* ---------- complete / partial ---------- */

describe('S5 complete', () => {
  it('is settled: the quiet label, 訳を隠す and 設定', () => {
    expectDecision(decide(view({ done: 40 })), D({
      state: 'S5',
      tone: 'settled',
      status: 'AIによる日本語訳',
      actions: [HIDE, SETTINGS],
    }));
  });

  it('says 訳を隠しています and offers 訳を表示 when hidden; carries the preface', () => {
    expectDecision(decide(view({ done: 40, hidden: true, hasPreface: true })), D({
      state: 'S5',
      tone: 'settled',
      status: '訳を隠しています',
      actions: [SHOW, SETTINGS],
      preface: true,
    }));
  });
});

describe('S5g complete with gaps', () => {
  const gaps = stopOf('gaps');
  const resume = (disabled: boolean): ActionSpec => ({ id: 'resume', label: '抜けた行を訳す', primary: true, disabled });

  it('counts the missing lines in a caption and offers the gap fill first', () => {
    expectDecision(decide(view({ done: 37, stop: gaps })), D({
      state: 'S5g',
      captions: [{ text: '3行が訳せていません。下の「――」の行です' }],
      actions: [resume(false), HIDE, SETTINGS],
      lines: { slots: false, gaps: true, breathing: false, seam: null },
    }));
  });

  it('carries the preface and 訳を表示 when hidden', () => {
    const d = decide(view({ done: 37, stop: gaps, hasPreface: true, hidden: true }));
    expect(d.preface).toBe(true);
    expect(d.actions).toEqual([resume(false), SHOW, SETTINGS]);
  });

  it('another song running: the blocker is a reason caption beside a disabled primary', () => {
    const d = decide(view({ done: 37, stop: gaps, otherSong: 'X' }));
    expect(d.captions).toEqual([{ text: '3行が訳せていません。下の「――」の行です' }, { text: BLOCKED_BY_OTHER, tone: 'reason' }]);
    expect(d.actions[0]).toEqual(resume(true));
  });

  it('a spent daily quota: the reset time as the reason, button disabled', () => {
    const d = decide(view({ done: 37, stop: gaps, avail: { ok: false, until: SOON } }));
    expect(d.captions[1]).toEqual({ text: quotaBlocker(SOON), tone: 'reason' });
    expect(d.actions[0]).toEqual(resume(true));
  });

  it('a spent quota with an unknown reset says あとで', () => {
    const d = decide(view({ done: 37, stop: gaps, avail: { ok: false, until: 0 } }));
    expect(d.captions[1]).toEqual({ text: '今日の無料枠を使い切りました。あとで訳せます', tone: 'reason' });
  });
});

describe('S7 Genius changed the lyrics', () => {
  const resume = (disabled: boolean): ActionSpec => ({ id: 'resume', label: '新しい行を訳す', primary: true, disabled });

  it('says how many lines are new and offers 新しい行を訳す', () => {
    expectDecision(decide(view({ done: 37 })), D({
      state: 'S7',
      captions: [{ text: '歌詞が更新されました。まだ訳していない行が3行あります' }],
      actions: [resume(false), HIDE, SETTINGS],
      lines: { slots: true, gaps: false, breathing: false, seam: null },
    }));
  });

  it('carries the preface and 訳を表示 when hidden', () => {
    const d = decide(view({ done: 37, hasPreface: true, hidden: true }));
    expect(d.preface).toBe(true);
    expect(d.actions).toEqual([resume(false), SHOW, SETTINGS]);
  });

  it('another song running: a reason caption + disabled button', () => {
    const d = decide(view({ done: 37, otherSong: 'X' }));
    expect(d.captions[1]).toEqual({ text: BLOCKED_BY_OTHER, tone: 'reason' });
    expect(d.actions[0]).toEqual(resume(true));
  });

  it('quota spent: reset time caption + disabled button', () => {
    const d = decide(view({ done: 37, avail: { ok: false, until: TOMORROW } }));
    expect(d.captions[1]).toEqual({ text: quotaBlocker(TOMORROW), tone: 'reason' });
    expect(d.actions[0]).toEqual(resume(true));
  });
});

describe('S6 interrupted', () => {
  const partial = { done: 12, total: 67 };

  type Row = { name: string; stop: StopInfo; over?: Partial<ViewInput> };
  const rows: Row[] = [
    { name: 'busy', stop: stopOf('busy') },
    { name: 'rate before until', stop: stopOf('rate', { until: MINUTE_LATER }) },
    { name: 'rate at until reads as closed', stop: stopOf('rate', { until: NOW }) },
    { name: 'quota', stop: stopOf('quota', { until: SOON }), over: { avail: { ok: false, until: SOON } } },
    { name: 'quota, reset tomorrow', stop: stopOf('quota', { until: TOMORROW }), over: { avail: { ok: false, until: TOMORROW } } },
    { name: 'auth with a rejected key', stop: stopOf('auth'), over: { keyBad: true } },
    { name: 'blocked', stop: stopOf('blocked') },
    { name: 'network, online', stop: stopOf('network') },
    { name: 'network, offline', stop: stopOf('network'), over: { online: false } },
    { name: 'silent', stop: stopOf('silent') },
    { name: 'unusable benched', stop: stopOf('unusable', { until: NOW + 600_000 }) },
    { name: 'length', stop: stopOf('length') },
    { name: 'stopped', stop: stopOf('stopped') },
    { name: 'closed', stop: stopOf('closed') },
  ];
  const run = (row: Row, over: Partial<ViewInput> = {}) => decide(view({ ...partial, stop: row.stop, ...row.over, ...over }));

  it.each(rows)('$name: the seam, the progress caption and the bar', (row) => {
    const d = run(row);
    expect(d.state).toBe('S6');
    expect(d.tone).toBe('speaking');
    expect(d.status).toBe('');
    expect(d.captions).toEqual([{ text: '67行のうち12行を訳してあります' }]);
    expect(d.progress).toEqual({ value: 12, max: 67 });
    expect(d.count).toBeUndefined();
    expect(d.lines).toMatchObject({ slots: true, gaps: false, breathing: false });
    expect(d.lines.seam).not.toBeNull();
    expect(d.actions[0]).toEqual({ ...d.lines.seam!.button, primary: true });
  });

  it('puts the seam button first, then 訳を隠す and 設定', () => {
    expectDecision(decide(view({ ...partial, stop: stopOf('busy') })), D({
      state: 'S6',
      captions: [{ text: '67行のうち12行を訳してあります' }],
      progress: { value: 12, max: 67 },
      actions: [{ id: 'resume', label: '続きを訳す', disabled: false, primary: true }, HIDE, SETTINGS],
      lines: { slots: true, gaps: false, breathing: false, seam: { text: 'AIが混み合っていて、ここで途切れました。少しおいてから続きを訳せます', button: { id: 'resume', label: '続きを訳す', disabled: false } } },
    }));
  });

  it('auth: the primary is 設定を開く and there is no second 設定', () => {
    const d = decide(view({ ...partial, stop: stopOf('auth'), keyBad: true }));
    expect(d.actions).toEqual([{ id: 'settings', label: '設定を開く', primary: true }, HIDE]);
  });

  it('carries the preface and 訳を表示 when hidden', () => {
    const d = decide(view({ ...partial, stop: stopOf('busy'), hasPreface: true, hidden: true }));
    expect(d.preface).toBe(true);
    expect(d.actions[1]).toEqual(SHOW);
  });

  it('another song running: the seam button is disabled and the blocker is in the seam text', () => {
    const d = decide(view({ ...partial, stop: stopOf('busy'), otherSong: 'X' }));
    expect(d.lines.seam!.text).toBe('AIが混み合っていて、ここで途切れました。別の曲を訳し終えると、この曲も訳せます');
    expect(d.lines.seam!.button).toEqual({ id: 'noop', label: '続きを訳す', disabled: true });
    expect(d.actions[0]).toEqual({ id: 'noop', label: '続きを訳す', disabled: true, primary: true });
  });

  describe('with 訳を隠す on', () => {
    it('stays quiet when the seam button can simply be pressed', () => {
      const d = decide(view({ done: 10, hidden: true, stop: stopOf('busy') }));
      expect(d.state).toBe('S6');
      expect(d.captions).toEqual([{ text: '40行のうち10行を訳してあります' }]);
      expect(d.actions).toEqual([{ id: 'resume', label: '続きを訳す', disabled: false, primary: true }, SHOW, SETTINGS]);
    });

    it('a blocked/closed/stopped/length seam that works says nothing either', () => {
      for (const reason of ['blocked', 'closed', 'stopped', 'length', 'unusable'] as const) {
        expect(decide(view({ done: 10, hidden: true, stop: stopOf(reason) })).captions).toHaveLength(1);
      }
    });

    it('a blocked button gets the seam sentence as a reason caption, with no ここ to point at', () => {
      const d = decide(view({ done: 10, hidden: true, stop: stopOf('busy'), otherSong: 'X' }));
      expect(d.captions).toHaveLength(2);
      expect(d.captions[1]).toEqual({ text: 'AIが混み合っていて、途中で途切れました。別の曲を訳し終えると、この曲も訳せます', tone: 'reason' });
      expect(d.lines.seam?.text).toBe('AIが混み合っていて、ここで途切れました。別の曲を訳し終えると、この曲も訳せます');
      const closed = decide(view({ done: 10, hidden: true, stop: stopOf('closed'), otherSong: 'X' }));
      expect(closed.captions[1]!.text).toBe('途中まで訳してあります。別の曲を訳し終えると、この曲も訳せます');
    });

    it('auth explains itself too (the seam is hidden with the translation)', () => {
      const d = decide(view({ done: 10, hidden: true, stop: stopOf('auth'), keyBad: true }));
      expect(d.captions[1]).toEqual({ text: 'APIキーが使えなくなりました。設定でキーを入れ直してください', tone: 'reason' });
    });

    it('never adds a reason when 訳を隠す is off, whatever blocks the button', () => {
      for (const row of rows) expect(run(row, { hidden: false }).captions).toHaveLength(1);
    });
  });
});

/* ---------- S8f ---------- */

describe('S8f retranslation failed', () => {
  const notice = { status: '訳し直せませんでした。今の訳はそのまま残っています', detail: 'AIの回数制限にかかりました。1分ほどおいてからもう一度試せます' };

  it('is settled: the quiet label, the notice as a caption and its detail as a reason', () => {
    expectDecision(decide(view({ done: 25, notice })), D({
      state: 'S8f',
      tone: 'settled',
      status: 'AIによる日本語訳',
      captions: [{ text: notice.status }, { text: notice.detail, tone: 'reason' }],
      actions: [HIDE, SETTINGS],
    }));
  });

  it('has only the first caption when the notice has no detail', () => {
    const d = decide(view({ done: 25, notice: { status: notice.status, detail: '' } }));
    expect(d.captions).toEqual([{ text: notice.status }]);
  });

  it('applies to a finished song as well (the case it exists for), keeping preface and 訳を表示', () => {
    expectDecision(decide(view({ done: 40, hasPreface: true, hidden: true, notice })), D({
      state: 'S8f',
      tone: 'settled',
      status: 'AIによる日本語訳',
      captions: [{ text: notice.status }, { text: notice.detail, tone: 'reason' }],
      actions: [SHOW, SETTINGS],
      preface: true,
    }));
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

/* ---------- copy rules ---------- */

describe('copy never joins sentences with a middle dot', () => {
  it('no status or caption of any state contains · ', () => {
    const inputs: ViewInput[] = [
      view({ hasKey: false }), view(), view({ japanese: true }), view({ otherSong: 'X' }), view({ avail: { ok: false, until: SOON } }),
      view({ stop: stopOf('busy') }), view({ running: 'here', waitedMs: 20_000, streams: false }), view({ running: 'here', done: 3 }),
      view({ mirrored: true }), view({ running: 'here-retranslate', done: 40 }), view({ done: 40 }), view({ done: 37, stop: stopOf('gaps'), otherSong: 'X' }),
      view({ done: 37 }), view({ done: 12, stop: stopOf('busy'), hidden: true, otherSong: 'X' }), view({ done: 40, notice: { status: 'a', detail: 'b' } }),
    ];
    for (const i of inputs) {
      const d = decide(i);
      for (const text of [d.status, ...d.captions.map((c) => c.text)]) expect(text).not.toMatch(/ · /);
    }
  });

  it('a primary action always comes first and only one exists', () => {
    for (const over of [{}, { hasKey: false }, { done: 37 }, { done: 12, stop: stopOf('busy') }, { stop: stopOf('busy') }, { done: 37, stop: stopOf('gaps') }]) {
      const d = decide(view(over));
      const idx = d.actions.map((a, n) => (a.primary ? n : -1)).filter((n) => n >= 0);
      expect(idx.length).toBeLessThanOrEqual(1);
      if (idx.length) expect(idx[0]).toBe(0);
      if (idx.length) expect(d.status).toBe('');
    }
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

  it('quota, rate and unusable: closed once `until` has passed (inclusive of now)', () => {
    for (const reason of ['quota', 'rate', 'unusable'] as const) {
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

  it.each<StopReason>(['busy', 'blocked', 'network', 'rejected', 'no-model', 'empty', 'silent', 'stopped', 'length', 'closed', 'gaps'])('leaves %s alone', (reason) => {
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
    ['rejected', 'AIへの依頼が通らず、ここで途切れました。もう一度試すと通ることがあります'],
    ['no-model', '今はAIを使えません。少しおいてから続きを訳せます'],
    ['empty', 'AIの返事が空で、ここで途切れました。もう一度試せます'],
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
    expect(seamText(stopOf('quota', { until: SOON }), i)).toBe(`今日の無料枠を使い切りました。${at(SOON)}から続きを訳せます`);
    expect(seamText(stopOf('quota', { until: TOMORROW }), i)).toBe(`今日の無料枠を使い切りました。${at(TOMORROW)}から続きを訳せます`);
  });

  it.each([
    ['no until', undefined],
    ['until 0', 0],
    ['until in the past', NOW - 1],
    ['until exactly now', NOW],
  ])('quota with %s says あとで', (_name, until) => {
    expect(seamText(stopOf('quota', until === undefined ? {} : { until }), i)).toBe('今日の無料枠を使い切りました。あとで続きを訳せます');
  });

  it('blocked says to try again', () => {
    expect(seamText(stopOf('blocked'), view())).toBe('この先はAIの安全フィルタで止められました。もう一度試すと通ることがあります');
  });

  it('measures the reset against the input clock', () => {
    expect(seamText(stopOf('quota', { until: SOON }), view({ now: SOON }))).toBe('今日の無料枠を使い切りました。あとで続きを訳せます');
  });
});

describe('startFailText', () => {
  const i = view();

  it.each<[StopReason, string]>([
    ['busy', 'AIが混み合っていて、訳し始められませんでした。少しおいてからもう一度試せます'],
    ['rate', 'AIの回数制限にかかりました。1分ほどおいてから訳せます'],
    ['auth', 'APIキーが使えなくなりました。設定でキーを入れ直してください'],
    ['network', '接続が切れて、訳し始められませんでした。つながったら訳せます'],
    ['rejected', 'AIへの依頼が通らず、訳し始められませんでした。もう一度試すと通ることがあります'],
    ['no-model', '今はAIを使えません。少しおいてからもう一度試せます'],
    ['empty', 'AIの返事が空で、訳し始められませんでした。もう一度試せます'],
    ['unusable', 'AIの返事をうまく読み取れませんでした。もう一度試せます'],
    ['length', '長い曲なので、一度では訳し切れませんでした'],
  ])('%s', (reason, text) => {
    expect(startFailText(stopOf(reason), i)).toBe(text);
  });

  it('quota names the reset time or says あとで', () => {
    expect(startFailText(stopOf('quota', { until: SOON }), i)).toBe(`今日の無料枠を使い切りました。${at(SOON)}から訳せます`);
    expect(startFailText(stopOf('quota', { until: TOMORROW }), i)).toBe('今日の無料枠を使い切りました。明日 1:00から訳せます');
    expect(startFailText(stopOf('quota'), i)).toBe('今日の無料枠を使い切りました。あとで訳せます');
    expect(startFailText(stopOf('quota', { until: NOW - 1 }), i)).toBe('今日の無料枠を使い切りました。あとで訳せます');
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
    ['busy', 'AIが混み合っていました。少しおいてからもう一度試せます'],
    ['rate', 'AIの回数制限にかかりました。1分ほどおいてからもう一度試せます'],
    ['auth', 'APIキーが使えなくなりました。設定でキーを入れ直してください'],
    ['blocked', 'AIの安全フィルタで止められました'],
    ['network', '接続が切れました'],
    ['rejected', 'AIへの依頼が通りませんでした'],
    ['no-model', 'AIを使えませんでした'],
    ['empty', 'AIの返事が空でした'],
    ['unusable', 'AIの返事をうまく読み取れませんでした'],
    ['stopped', '止めました'],
    ['length', '長い曲なので、一度では訳し切れませんでした'],
    ['closed', '返事が途中で途切れました'],
    ['gaps', '訳せない行が残りました'],
  ])('%s', (reason, text) => {
    expect(failureText(stopOf(reason), NOW)).toBe(text);
  });

  it('quota names the reset time as when to try again, or nothing', () => {
    expect(failureText(stopOf('quota', { until: SOON }), NOW)).toBe(`今日の無料枠を使い切りました。${at(SOON)}からもう一度試せます`);
    expect(failureText(stopOf('quota', { until: TOMORROW }), NOW)).toBe('今日の無料枠を使い切りました。明日 1:00からもう一度試せます');
    expect(failureText(stopOf('quota'), NOW)).toBe('今日の無料枠を使い切りました');
    expect(failureText(stopOf('quota', { until: NOW - 1 }), NOW)).toBe('今日の無料枠を使い切りました');
  });

  it('never promises a 続き (S8f offers none)', () => {
    const reasons: StopReason[] = ['busy', 'rate', 'quota', 'auth', 'blocked', 'network', 'rejected', 'no-model', 'empty', 'unusable', 'stopped', 'length', 'closed', 'gaps'];
    for (const reason of reasons) expect(failureText(stopOf(reason, { until: SOON }), NOW)).not.toContain('続き');
  });
});

describe('copy on the reading surface does not talk about models', () => {
  const ALL: StopReason[] = ['busy', 'rate', 'quota', 'auth', 'blocked', 'network', 'rejected', 'no-model', 'empty', 'unusable', 'stopped', 'length', 'closed', 'gaps'];
  const i = view({ done: 6, total: 20 });

  it('no seam, start-failure or reason sentence mentions モデル', () => {
    for (const reason of ALL) {
      const stop = stopOf(reason, { until: SOON });
      expect(seamText(stop, i)).not.toMatch(/モデル/);
      expect(startFailText(stop, i)).not.toMatch(/モデル/);
      expect(failureText(stop, NOW)).not.toMatch(/モデル/);
    }
  });

  it('rejected at the seam (after 6 of 20 lines of "Smoke in the whip, windows up, nobody talk") offers an enabled 続きを訳す', () => {
    expect(seamFor(stopOf('rejected'), i, null)).toEqual({
      text: 'AIへの依頼が通らず、ここで途切れました。もう一度試すと通ることがあります',
      button: { id: 'resume', label: '続きを訳す', disabled: false },
    });
  });

  it('a silent Gemini is told as silence, not as a lost connection, and the start button stays enabled', () => {
    const d = decide(view({ online: true, done: 0, total: 18, stop: stopOf('silent') }));
    expect(d.state).toBe('S2f');
    expect(d.captions[0]!.text).toBe('AIから返事がなく、訳し始められませんでした。少しおいてからもう一度試せます');
    expect(d.captions[0]!.text).not.toMatch(/接続/);
    expect(d.actions[0]).toEqual({ id: 'start', label: 'もう一度訳す', primary: true, disabled: false });
  });

  it('a silent stop after some lines puts silence in the seam and keeps 続きを訳す enabled', () => {
    const d = decide(view({ online: true, done: 7, total: 18, stop: stopOf('silent') }));
    expect(d.state).toBe('S6');
    expect(d.lines.seam!.text).toBe('AIから返事がなく、ここで途切れました。少しおいてから続きを訳せます');
    expect(d.lines.seam!.text).not.toMatch(/接続/);
    expect(d.lines.seam!.button).toEqual({ id: 'resume', label: '続きを訳す', disabled: false });
  });

  it('the retranslation failure line for a silent stop does not blame the connection', () => {
    expect(failureText(stopOf('silent'), NOW)).toBe('AIから返事がありませんでした');
  });

  it('no-model before any line is S2f with a plain sentence', () => {
    const d = decide(view({ done: 0, total: 20, stop: stopOf('no-model') }));
    expect(d.state).toBe('S2f');
    expect(d.captions[0]!.text).toBe('今はAIを使えません。少しおいてからもう一度試せます');
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
    expect(seamFor(stopOf('network'), i, 'BLOCK')).toEqual({
      text: '接続が切れました。BLOCK',
      button: { id: 'noop', label: '続きを訳す', disabled: true },
    });
    // The lock blocker (another song running) keeps the join for every reason.
    expect(seamFor(stopOf('busy'), view({ otherSong: 'X' }), 'BLOCK')).toEqual({
      text: 'AIが混み合っていて、ここで途切れました。BLOCK',
      button: { id: 'noop', label: '続きを訳す', disabled: true },
    });
  });

  it.each<StopReason>(['rate', 'busy', 'no-model'])('a transient %s stop next to a spent quota only says where it stopped', (reason) => {
    expect(seamFor(stopOf(reason), i, 'BLOCK')).toEqual({
      text: 'ここで途切れました。BLOCK',
      button: { id: 'noop', label: '続きを訳す', disabled: true },
    });
  });

  it('a blocker without a hint on quota: the quota sentence, a disabled resume (not noop)', () => {
    expect(seamFor(stopOf('quota', { until: SOON }), i, 'BLOCK')).toEqual({
      text: `今日の無料枠を使い切りました。${at(SOON)}から続きを訳せます`,
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
