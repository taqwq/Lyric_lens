/*
 * The reading surface's state machine (docs/DESIGN.md §3, S0–S8f) as a pure function:
 * everything it needs comes in through ViewInput (no DOM, storage, clock or navigator), and
 * what it returns names actions by id instead of closures, so every state and every
 * sentence is unit-tested (tests/state.test.ts).
 */
import type { StopInfo } from '../core/types';
import type { Availability } from '../llm/chain';
import { formatWhen } from './time';

export type ActionId = 'start' | 'resume' | 'stop' | 'stopMirror' | 'stopOther' | 'hide' | 'settings' | 'firstRun' | 'noop';

export interface ActionSpec {
  id: ActionId;
  label: string;
  primary?: boolean;
  disabled?: boolean;
}

export interface SeamSpec {
  text: string;
  button: ActionSpec;
}

export type StateName = 'S1' | 'SJ' | 'S2' | 'S2b' | 'S2q' | 'S2f' | 'S3' | 'S4' | 'S4m' | 'S5' | 'S5g' | 'S6' | 'S7' | 'S8' | 'S8f';

export interface ViewInput {
  now: number;
  online: boolean;
  /** Answers arrive incrementally here (transportStreams()). */
  streams: boolean;
  /** How long this tab's request has been waiting, in ms (undefined when none runs here). */
  waitedMs?: number;
  /** 訳を隠す is on. */
  hidden: boolean;
  /** A key is saved. */
  hasKey: boolean;
  /** The key is known to be rejected (an invalid-key stop still applies). */
  keyBad: boolean;
  total: number;
  done: number;
  /** Stop recorded on the edition on screen. */
  stop: StopInfo | undefined;
  hasPreface: boolean;
  /** The lyrics are already Japanese (isMostlyJapanese): nothing to translate, no request. */
  japanese?: boolean;
  running: 'none' | 'here' | 'here-retranslate';
  /** Another tab is writing this song. */
  mirrored: boolean;
  /** Title of another song being written (by this tab or another), if any. */
  otherSong: string | null;
  avail: Availability;
  notice: { status: string; detail: string } | null;
}

export interface Caption {
  text: string;
  /** 'reason': says why a button cannot be pressed, so it reads as text, not as a label. */
  tone?: 'reason';
}

export interface Decision {
  state: StateName;
  /** 'speaking': the head is working or asking; 'settled': nothing to do but read. */
  tone: 'speaking' | 'settled';
  /** The left-hand sentence; '' when a primary action takes its place. */
  status: string;
  captions: Caption[];
  count?: { done: number; total: number };
  progress: { value: number; max: number } | 'indeterminate' | null;
  /** Primary actions first, then the links in the fixed order 止める → 隠す/表示 → 設定. */
  actions: ActionSpec[];
  preface: boolean;
  lines: { slots: boolean; gaps: boolean; breathing: boolean; seam: SeamSpec | null };
}

const SETTINGS: ActionSpec = { id: 'settings', label: '設定' };
const STOP: ActionSpec = { id: 'stop', label: '止める' };

function hideAction(i: ViewInput): ActionSpec {
  return { id: 'hide', label: i.hidden ? '訳を表示' : '訳を隠す' };
}

function when(until: number | undefined, now: number): string {
  return until && until > now ? formatWhen(until, now) : '';
}

/** A stored stop that no longer applies reads as plain "ここまで訳してあります". */
export function liveStop(stop: StopInfo | undefined, i: ViewInput): StopInfo | undefined {
  if (!stop) return stop;
  if (stop.reason === 'auth' && !i.keyBad) return { reason: 'closed', at: stop.at };
  if (stop.reason === 'quota' && i.avail.ok) return { reason: 'closed', at: stop.at };
  if ((stop.reason === 'quota' || stop.reason === 'rate' || stop.reason === 'unusable') && stop.until && stop.until <= i.now) return { reason: 'closed', at: stop.at };
  return stop;
}

/** The seam's sentence: says where writing stopped and what can happen next. */
export function seamText(stop: StopInfo, i: ViewInput): string {
  const at = when(stop.until, i.now);
  // A bench that outlasts the usual minute (a timeout's 5 minutes, an unusable answer's 10) is
  // named by its end, not promised as "1分ほど".
  const long = stop.until !== undefined && stop.until - i.now > 90_000 && at !== '';
  const text: Record<StopInfo['reason'], string> = {
    busy: 'AIが混み合っていて、ここで途切れました。少しおいてから続きを訳せます',
    rate: long ? `AIの回数制限にかかりました。${at}ごろから続きを訳せます` : 'AIの回数制限にかかりました。1分ほどおいてから続きを訳せます',
    quota: `今日の無料枠を使い切りました。${at ? `${at}から` : 'あとで'}続きを訳せます`,
    auth: 'APIキーが使えなくなりました。設定でキーを入れ直してください',
    blocked: 'この先はAIの安全フィルタで止められました。もう一度試すと通ることがあります',
    network: '接続が切れました。つながったら続きを訳せます',
    silent: 'AIから返事がなく、ここで途切れました。少しおいてから続きを訳せます',
    rejected: 'AIへの依頼が通らず、ここで途切れました。もう一度試すと通ることがあります',
    'no-model': '今はAIを使えません。少しおいてから続きを訳せます',
    empty: 'AIの返事が空で、ここで途切れました。もう一度試せます',
    unusable: long ? `AIの返事をうまく読み取れず、ここで途切れました。${at}ごろからもう一度試せます` : 'AIの返事をうまく読み取れず、ここで途切れました。もう一度試せます',
    stopped: 'ここで止めました',
    length: '長い曲なので、ここで一度区切りました',
    closed: 'ここまで訳してあります',
    gaps: 'ここまで訳してあります',
  };
  return text[stop.reason];
}

/** Head-row sentence when the first request failed before any line arrived: no "ここ",
 *  no 続き — nothing is on the page yet. */
export function startFailText(stop: StopInfo, i: ViewInput): string {
  const at = when(stop.until, i.now);
  const long = stop.until !== undefined && stop.until - i.now > 90_000 && at !== '';
  const text: Partial<Record<StopInfo['reason'], string>> = {
    busy: 'AIが混み合っていて、訳し始められませんでした。少しおいてからもう一度試せます',
    rate: long ? `AIの回数制限にかかりました。${at}ごろから訳せます` : 'AIの回数制限にかかりました。1分ほどおいてから訳せます',
    quota: `今日の無料枠を使い切りました。${at ? `${at}から` : 'あとで'}訳せます`,
    auth: 'APIキーが使えなくなりました。設定でキーを入れ直してください',
    blocked: 'この曲はAIの安全フィルタで止められました。もう一度試すと通ることがあります',
    network: '接続が切れて、訳し始められませんでした。つながったら訳せます',
    silent: 'AIから返事がなく、訳し始められませんでした。少しおいてからもう一度試せます',
    rejected: 'AIへの依頼が通らず、訳し始められませんでした。もう一度試すと通ることがあります',
    'no-model': '今はAIを使えません。少しおいてからもう一度試せます',
    empty: 'AIの返事が空で、訳し始められませんでした。もう一度試せます',
    unusable: long ? `AIの返事をうまく読み取れませんでした。${at}ごろからもう一度試せます` : 'AIの返事をうまく読み取れませんでした。もう一度試せます',
    length: '長い曲なので、一度では訳し切れませんでした',
  };
  return text[stop.reason] ?? '';
}

/** Why a retranslation did not finish (S8f), without promising a 続き S8f does not offer. */
export function failureText(stop: StopInfo, now: number): string {
  const at = when(stop.until, now);
  const text: Record<StopInfo['reason'], string> = {
    busy: 'AIが混み合っていました。少しおいてからもう一度試せます',
    rate: 'AIの回数制限にかかりました。1分ほどおいてからもう一度試せます',
    quota: `今日の無料枠を使い切りました${at ? `。${at}からもう一度試せます` : ''}`,
    auth: 'APIキーが使えなくなりました。設定でキーを入れ直してください',
    blocked: 'AIの安全フィルタで止められました',
    network: '接続が切れました',
    silent: 'AIから返事がありませんでした',
    rejected: 'AIへの依頼が通りませんでした',
    'no-model': 'AIを使えませんでした',
    empty: 'AIの返事が空でした',
    unusable: 'AIの返事をうまく読み取れませんでした',
    stopped: '止めました',
    length: '長い曲なので、一度では訳し切れませんでした',
    closed: '返事が途中で途切れました',
    gaps: '訳せない行が残りました',
  };
  return text[stop.reason];
}

/** The seam's sentence said in the head row (S6 with the translation hidden, so the seam is
 *  hidden too): there is no line for ここ or この先 to point at. */
function inHead(text: string): string {
  return text.replace(/ここで/g, '途中で').replace(/ここまで/g, '途中まで').replace(/この先は/g, '途中から');
}

/** The seam's sentence and button. A blocker (another song running, quota spent) disables
 *  the button and is said right there. */
export function seamFor(stop: StopInfo, i: ViewInput, blocker: string | null): SeamSpec {
  const text = seamText(stop, i);
  if (stop.reason === 'auth') return { text, button: { id: 'settings', label: '設定を開く' } };
  if (blocker && stop.reason !== 'quota') {
    // A per-minute or busy stop next to a spent daily quota would name two limits: the quota
    // is the one that matters, so the first sentence only says where it stopped.
    const transient = stop.reason === 'rate' || stop.reason === 'busy' || stop.reason === 'no-model' || stop.reason === 'silent';
    const quotaBlocker = !i.otherSong;
    const head = transient && quotaBlocker ? 'ここで途切れました' : text.split('。')[0];
    return { text: `${head}。${blocker}`, button: { id: 'noop', label: '続きを訳す', disabled: true } };
  }
  let disabled = Boolean(blocker);
  if (stop.reason === 'rate' && stop.until && i.now < stop.until) disabled = true;
  if (stop.reason === 'unusable' && stop.until && i.now < stop.until) disabled = true;
  if (stop.reason === 'network' && !i.online) disabled = true;
  return { text, button: { id: 'resume', label: '続きを訳す', disabled } };
}

export function decide(i: ViewInput): Decision {
  const missing = i.total - i.done;
  const quotaUntil = i.avail.ok ? null : i.avail.until;
  const blocker = i.otherSong
    ? '別の曲を訳し終えると、この曲も訳せます'
    : quotaUntil != null ? `今日の無料枠を使い切りました。${quotaUntil > i.now ? `${formatWhen(quotaUntil, i.now)}から訳せます` : 'あとで訳せます'}` : null;
  const none = { slots: false, gaps: false, breathing: false, seam: null };
  const writing = { slots: true, gaps: false, breathing: true, seam: null };
  const hide = hideAction(i);
  const reason = (text: string): Caption => ({ text, tone: 'reason' });
  const plain = { captions: [] as Caption[], progress: null };

  // S8: retranslating — the old edition stays readable until the new one is complete.
  if (i.running === 'here-retranslate') {
    return { state: 'S8', tone: 'speaking', status: '訳し直しています', captions: [{ text: '訳し終えるまでは、今の訳をそのまま表示します' }], progress: 'indeterminate', actions: [STOP], preface: i.hasPreface, lines: none };
  }
  // S3 / S4: this tab is writing this song. Arriving once the preface or any line is in.
  if (i.running === 'here') {
    const arriving = i.hasPreface || i.done > 0;
    // A slow first line reads the same as a hung one: say the wait is expected (no model, quota or switching).
    const slow = !arriving && (i.waitedMs ?? 0) >= 15_000;
    const captions: Caption[] = [];
    if (slow) captions.push({ text: 'AIの返事を待っています。混み合っていると1分ほどかかることもあります' });
    if (!i.streams) captions.push({ text: 'この環境では訳がまとめて届きます' });
    return {
      state: arriving ? 'S4' : 'S3',
      tone: 'speaking',
      status: arriving ? '訳しています' : '歌詞を読んでいます',
      captions,
      ...(arriving ? { count: { done: i.done, total: i.total } } : {}),
      progress: arriving ? { value: i.done, max: i.total } : 'indeterminate',
      actions: arriving ? [STOP, hide, SETTINGS] : [STOP],
      preface: i.hasPreface,
      lines: writing,
    };
  }
  // S4m: another tab is writing this song; follow it from storage.
  if (i.mirrored) {
    return { state: 'S4m', tone: 'speaking', status: '別のタブで訳しています', ...plain, actions: [{ id: 'stopMirror', label: '止める' }, hide], preface: i.hasPreface, lines: writing };
  }
  // S8f: a retranslation failed or could not start; the old edition is untouched.
  if (i.notice && i.done) {
    const captions: Caption[] = [{ text: i.notice.status }];
    if (i.notice.detail) captions.push(reason(i.notice.detail));
    return { state: 'S8f', tone: 'settled', status: 'AIによる日本語訳', captions, progress: null, actions: [hide, SETTINGS], preface: i.hasPreface, lines: none };
  }

  const stop = liveStop(i.stop, i);
  if (!i.done) {
    // SJ: Japanese lyrics need no translation; say so quietly instead of offering the start button.
    if (i.japanese) return { state: 'SJ', tone: 'settled', status: 'この曲の歌詞は日本語です', ...plain, actions: [], preface: false, lines: none };
    if (!i.hasKey) {
      return { state: 'S1', tone: 'speaking', status: '', captions: [{ text: '最初に一度だけ、無料のAPIキーを設定します' }], progress: null, actions: [{ id: 'firstRun', label: '日本語で読む', primary: true }], preface: false, lines: none };
    }
    if (i.otherSong) {
      return {
        state: 'S2b', tone: 'speaking', status: '別の曲を訳しています',
        captions: [{ text: `「${i.otherSong}」を訳し終えると、この曲も訳せます` }], progress: null,
        actions: [{ id: 'stopOther', label: 'あちらを止める' }], preface: false, lines: none,
      };
    }
    if (quotaUntil != null) {
      return {
        state: 'S2q', tone: 'speaking', status: '今日の無料枠を使い切りました',
        captions: quotaUntil > i.now ? [{ text: `${formatWhen(quotaUntil, i.now)}から、また訳せます` }] : [], progress: null,
        actions: [SETTINGS], preface: false, lines: none,
      };
    }
    if (stop && stop.reason !== 'closed' && stop.reason !== 'stopped') {
      // The first request produced nothing: say why, with the seam's button rule.
      const seam = seamFor(stop, i, null);
      const auth = stop.reason === 'auth';
      const button: ActionSpec = auth
        ? { id: 'settings', label: '設定を開く', primary: true }
        : { ...seam.button, id: seam.button.id === 'resume' ? 'start' : seam.button.id, label: 'もう一度訳す', primary: true };
      return {
        state: 'S2f', tone: 'speaking', status: '',
        captions: [{ text: startFailText(stop, i) || seam.text }], progress: null,
        actions: auth ? [button] : [button, SETTINGS], preface: false, lines: none,
      };
    }
    return { state: 'S2', tone: 'speaking', status: '', ...plain, actions: [{ id: 'start', label: '日本語で読む', primary: true }, SETTINGS], preface: false, lines: none };
  }

  // S5: complete.
  if (!missing) {
    return { state: 'S5', tone: 'settled', status: i.hidden ? '訳を隠しています' : 'AIによる日本語訳', ...plain, actions: [hide, SETTINGS], preface: i.hasPreface, lines: none };
  }

  const resume = (label: string): ActionSpec => ({ id: 'resume', label, primary: true, disabled: Boolean(blocker) });
  // S5g: the model skipped some lines.
  if (stop?.reason === 'gaps') {
    return {
      state: 'S5g', tone: 'speaking', status: '',
      captions: [{ text: `${missing}行が訳せていません。下の「――」の行です` }, ...(blocker ? [reason(blocker)] : [])], progress: null,
      actions: [resume('抜けた行を訳す'), hide, SETTINGS],
      preface: i.hasPreface,
      lines: { slots: false, gaps: true, breathing: false, seam: null },
    };
  }
  // S7: Genius changed the lyrics since the edition was finished.
  if (!stop) {
    return {
      state: 'S7', tone: 'speaking', status: '',
      captions: [{ text: `歌詞が更新されました。まだ訳していない行が${missing}行あります` }, ...(blocker ? [reason(blocker)] : [])], progress: null,
      actions: [resume('新しい行を訳す'), hide, SETTINGS],
      preface: i.hasPreface,
      lines: { slots: true, gaps: false, breathing: false, seam: null },
    };
  }
  // S6: interrupted; the seam sits at the writing frontier.
  const seam = seamFor(stop, i, blocker);
  // The seam is a lyric-line node and hides with the translation: then say why the button
  // cannot simply be pressed in the head instead (never both, never when it just works).
  const explain = i.hidden && (Boolean(seam.button.disabled) || stop.reason === 'auth');
  return {
    state: 'S6', tone: 'speaking', status: '',
    captions: [{ text: `${i.total}行のうち${i.done}行を訳してあります` }, ...(explain ? [reason(inHead(seam.text))] : [])],
    progress: { value: i.done, max: i.total },
    actions: [{ ...seam.button, primary: true }, hide, ...(seam.button.id === 'settings' ? [] : [SETTINGS])],
    preface: i.hasPreface,
    lines: { slots: true, gaps: false, breathing: false, seam },
  };
}
