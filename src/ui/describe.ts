import { nextPacificMidnight } from '../llm/chain';
import type { LLMError } from '../llm/errors';

export interface ErrorText {
  title: string;
  detail: string;
  /** Opening settings is the likely fix. */
  settings: boolean;
}

function resetTime(): string {
  return new Date(nextPacificMidnight()).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

export function describeError(error: LLMError, partial: boolean): ErrorText {
  const saved = partial ? '途中までの訳は保存済みで、続きから再開できる。' : '';
  const where = [error.provider, error.model].filter(Boolean).join(' · ');
  switch (error.kind) {
    case 'auth':
      return { title: 'APIキーを確認して', detail: `キーが無効か、使う権限がない（${where || 'API'}）。`, settings: true };
    case 'quota':
      return {
        title: '今日の無料枠を使い切った',
        detail: `Gemini の無料枠は ${resetTime()} ごろにリセット。設定で予備の API（Groq など）を足すと、そのまま続けられる。${saved}`,
        settings: true,
      };
    case 'rate':
      return { title: '回数制限にかかった', detail: `1分あたりの上限。少し待ってからもう一度。${saved}`, settings: false };
    case 'overloaded':
      return { title: 'モデルが混雑している', detail: `${where ? `${where} が` : ''}一時的に混み合っている。少し待ってからもう一度。${saved}`, settings: false };
    case 'blocked':
      return { title: 'モデルが生成を止めた', detail: `安全判定などで止まった（${error.message}）。設定で別のモデルや予備の API を選ぶと通ることがある。${saved}`, settings: true };
    case 'not-found':
      return { title: 'このモデルは使えない', detail: `${where} は利用できない。設定でモデルを「自動」にして。`, settings: true };
    case 'bad-request':
      return { title: 'リクエストが拒否された', detail: `${error.message.slice(0, 200)}${saved ? ` ${saved}` : ''}`, settings: true };
    case 'network':
      return { title: 'ネットワークにつながらない', detail: `接続を確認して、もう一度。${saved}`, settings: false };
    case 'timeout':
      return { title: '応答が途中で止まった', detail: `もう一度押すと続きから訳す。${saved}`, settings: false };
    case 'empty':
      return { title: '訳を受け取れなかった', detail: `モデルが決められた形式で答えなかった。もう一度試すか、設定で別のモデルを選んで。${saved}`, settings: true };
    default:
      return { title: 'うまくいかなかった', detail: `${error.message.slice(0, 200)} ${saved}`.trim(), settings: false };
  }
}
