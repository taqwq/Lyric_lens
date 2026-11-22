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
  /** Primary actions first, then the links in the fixed order 停止 → 隠す/表示 → 設定. */
  actions: ActionSpec[];
  preface: boolean;
  lines: { slots: boolean; gaps: boolean; breathing: boolean; seam: SeamSpec | null };
}

const SETTINGS: ActionSpec = { id: 'settings', label: '設定' };
const STOP: ActionSpec = { id: 'stop', label: '停止' };

function hideAction(i: ViewInput): ActionSpec {
  return { id: 'hide', label: i.hidden ? '訳を表示' : '訳を隠す' };
}

function when(until: number | undefined, now: number): string {
  return until && until > now ? formatWhen(until, now) : '';
}

/** A stored stop that no longer applies reads as plain "ここまで翻訳済みです". */
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
    busy: 'AIが混雑しているため、ここで中断しました。しばらくしてから続きを翻訳できます',
    rate: long ? `AIの利用回数の上限に達しました。${at}頃から続きを翻訳できます` : 'AIの利用回数の上限に達しました。1分ほど待ってから続きを翻訳できます',
    quota: `本日の無料枠を使い切りました。${at ? `${at}から` : '後ほど'}続きを翻訳できます`,
    auth: 'APIキーが無効になりました。設定でキーを入力し直してください',
    blocked: 'この先はAIの安全フィルタにより停止されました。再試行すると翻訳できる場合があります',
    network: '接続が切れました。接続が回復すると続きを翻訳できます',
    silent: 'AIから応答がなく、ここで中断しました。しばらくしてから続きを翻訳できます',
    rejected: 'AIへのリクエストが拒否され、ここで中断しました。再試行すると翻訳できる場合があります',
    'no-model': '現在AIを利用できません。しばらくしてから続きを翻訳できます',
    empty: 'AIの応答が空だったため、ここで中断しました。再試行できます',
    unusable: long ? `AIの応答を読み取れず、ここで中断しました。${at}頃から再試行できます` : 'AIの応答を読み取れず、ここで中断しました。再試行できます',
    stopped: 'ここで停止しました',
    length: '曲が長いため、ここで一度区切りました',
    closed: 'ここまで翻訳済みです',
    gaps: 'ここまで翻訳済みです',
  };
  return text[stop.reason];
}

/** Head-row sentence when the first request failed before any line arrived: no "ここ",
 *  no 続き — nothing is on the page yet. */
export function startFailText(stop: StopInfo, i: ViewInput): string {
  const at = when(stop.until, i.now);
  const long = stop.until !== undefined && stop.until - i.now > 90_000 && at !== '';
  const text: Partial<Record<StopInfo['reason'], string>> = {
    busy: 'AIが混雑しているため、翻訳を開始できませんでした。しばらくしてから再試行できます',
    rate: long ? `AIの利用回数の上限に達しました。${at}頃から翻訳できます` : 'AIの利用回数の上限に達しました。1分ほど待ってから翻訳できます',
    quota: `本日の無料枠を使い切りました。${at ? `${at}から` : '後ほど'}翻訳できます`,
    auth: 'APIキーが無効になりました。設定でキーを入力し直してください',
    blocked: 'この曲はAIの安全フィルタにより停止されました。再試行すると翻訳できる場合があります',
    network: '接続が切れたため、翻訳を開始できませんでした。接続が回復すると翻訳できます',
    silent: 'AIから応答がなく、翻訳を開始できませんでした。しばらくしてから再試行できます',
    rejected: 'AIへのリクエストが拒否され、翻訳を開始できませんでした。再試行すると翻訳できる場合があります',
    'no-model': '現在AIを利用できません。しばらくしてから再試行できます',
    empty: 'AIの応答が空だったため、翻訳を開始できませんでした。再試行できます',
    unusable: long ? `AIの応答を読み取れませんでした。${at}頃から再試行できます` : 'AIの応答を読み取れませんでした。再試行できます',
    length: '曲が長いため、一度で翻訳しきれませんでした',
  };
  return text[stop.reason] ?? '';
}

/** Why a retranslation did not finish (S8f), without promising a 続き S8f does not offer. */
export function failureText(stop: StopInfo, now: number): string {
  const at = when(stop.until, now);
  const text: Record<StopInfo['reason'], string> = {
    busy: 'AIが混雑していました。しばらくしてから再試行できます',
    rate: 'AIの利用回数の上限に達しました。1分ほど待ってから再試行できます',
    quota: `本日の無料枠を使い切りました${at ? `。${at}から再試行できます` : ''}`,
    auth: 'APIキーが無効になりました。設定でキーを入力し直してください',
    blocked: 'AIの安全フィルタにより停止されました',
    network: '接続が切れました',
    silent: 'AIから応答がありませんでした',
    rejected: 'AIへのリクエストが拒否されました',
    'no-model': 'AIを利用できませんでした',
    empty: 'AIの応答が空でした',
    unusable: 'AIの応答を読み取れませんでした',
    stopped: '停止しました',
    length: '曲が長いため、一度で翻訳しきれませんでした',
    closed: '応答が途中で途切れました',
    gaps: '翻訳できない行が残りました',
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
    const head = transient && quotaBlocker ? 'ここで中断しました' : text.split('。')[0];
    return { text: `${head}。${blocker}`, button: { id: 'noop', label: '続きを翻訳', disabled: true } };
  }
  let disabled = Boolean(blocker);
  if (stop.reason === 'rate' && stop.until && i.now < stop.until) disabled = true;
  if (stop.reason === 'unusable' && stop.until && i.now < stop.until) disabled = true;
  if (stop.reason === 'network' && !i.online) disabled = true;
  return { text, button: { id: 'resume', label: '続きを翻訳', disabled } };
}

export function decide(i: ViewInput): Decision {
  const missing = i.total - i.done;
  const quotaUntil = i.avail.ok ? null : i.avail.until;
  const blocker = i.otherSong
    ? '別の曲の翻訳が終わると、この曲を翻訳できます'
    : quotaUntil != null ? `本日の無料枠を使い切りました。${quotaUntil > i.now ? `${formatWhen(quotaUntil, i.now)}から翻訳できます` : '後ほど翻訳できます'}` : null;
  const none = { slots: false, gaps: false, breathing: false, seam: null };
  const writing = { slots: true, gaps: false, breathing: true, seam: null };
  const hide = hideAction(i);
  const reason = (text: string): Caption => ({ text, tone: 'reason' });
  const plain = { captions: [] as Caption[], progress: null };

  // S8: retranslating — the old edition stays readable until the new one is complete.
  if (i.running === 'here-retranslate') {
    return { state: 'S8', tone: 'speaking', status: '再翻訳しています', captions: [{ text: '完了するまで、現在の訳を表示します' }], progress: 'indeterminate', actions: [STOP], preface: i.hasPreface, lines: none };
  }
  // S3 / S4: this tab is writing this song. Arriving once the preface or any line is in.
  if (i.running === 'here') {
    const arriving = i.hasPreface || i.done > 0;
    // A slow first line reads the same as a hung one: say the wait is expected (no model, quota or switching).
    const slow = !arriving && (i.waitedMs ?? 0) >= 15_000;
    const captions: Caption[] = [];
    if (slow) captions.push({ text: 'AIの応答を待っています。混雑時は1分ほどかかる場合があります' });
    if (!i.streams) captions.push({ text: 'この環境では、訳はまとめて表示されます' });
    return {
      state: arriving ? 'S4' : 'S3',
      tone: 'speaking',
      status: arriving ? '翻訳しています' : '歌詞を読み込んでいます',
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
    return { state: 'S4m', tone: 'speaking', status: '別のタブで翻訳しています', ...plain, actions: [{ id: 'stopMirror', label: '停止' }, hide], preface: i.hasPreface, lines: writing };
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
      return { state: 'S1', tone: 'speaking', status: '', captions: [{ text: '初回のみ、無料のAPIキーの設定が必要です' }], progress: null, actions: [{ id: 'firstRun', label: '日本語に翻訳', primary: true }], preface: false, lines: none };
    }
    if (i.otherSong) {
      return {
        state: 'S2b', tone: 'speaking', status: '別の曲を翻訳しています',
        captions: [{ text: `「${i.otherSong}」の翻訳が終わると、この曲を翻訳できます` }], progress: null,
        actions: [{ id: 'stopOther', label: 'その曲を停止' }], preface: false, lines: none,
      };
    }
    if (quotaUntil != null) {
      return {
        state: 'S2q', tone: 'speaking', status: '本日の無料枠を使い切りました',
        captions: quotaUntil > i.now ? [{ text: `${formatWhen(quotaUntil, i.now)}から再び翻訳できます` }] : [], progress: null,
        actions: [SETTINGS], preface: false, lines: none,
      };
    }
    if (stop && stop.reason !== 'closed' && stop.reason !== 'stopped') {
      // The first request produced nothing: say why, with the seam's button rule.
      const seam = seamFor(stop, i, null);
      const auth = stop.reason === 'auth';
      const button: ActionSpec = auth
        ? { id: 'settings', label: '設定を開く', primary: true }
        : { ...seam.button, id: seam.button.id === 'resume' ? 'start' : seam.button.id, label: '再試行', primary: true };
      return {
        state: 'S2f', tone: 'speaking', status: '',
        captions: [{ text: startFailText(stop, i) || seam.text }], progress: null,
        actions: auth ? [button] : [button, SETTINGS], preface: false, lines: none,
      };
    }
    return { state: 'S2', tone: 'speaking', status: '', ...plain, actions: [{ id: 'start', label: '日本語に翻訳', primary: true }, SETTINGS], preface: false, lines: none };
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
      captions: [{ text: `${missing}行を翻訳できませんでした（「――」の行）` }, ...(blocker ? [reason(blocker)] : [])], progress: null,
      actions: [resume('未翻訳の行を翻訳'), hide, SETTINGS],
      preface: i.hasPreface,
      lines: { slots: false, gaps: true, breathing: false, seam: null },
    };
  }
  // S7: Genius changed the lyrics since the edition was finished.
  if (!stop) {
    return {
      state: 'S7', tone: 'speaking', status: '',
      captions: [{ text: `歌詞が更新されました。未翻訳の行が${missing}行あります` }, ...(blocker ? [reason(blocker)] : [])], progress: null,
      actions: [resume('追加された行を翻訳'), hide, SETTINGS],
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
    captions: [{ text: `${i.total}行中${i.done}行を翻訳済みです` }, ...(explain ? [reason(inHead(seam.text))] : [])],
    progress: { value: i.done, max: i.total },
    actions: [{ ...seam.button, primary: true }, hide, ...(seam.button.id === 'settings' ? [] : [SETTINGS])],
    preface: i.hasPreface,
    lines: { slots: true, gaps: false, breathing: false, seam },
  };
}
