import { streamRequest } from '../platform/http';
import { LLMError, classifyHttpError } from './errors';
import { presetFor } from './presets';
import { SseParser } from './sse';
import type { GenerateRequest, GenerateResult, ModelInfo, Provider, ProviderConfig } from './types';

/** Drops <think>…</think> blocks that some open models emit inline, across chunk boundaries. */
export class ThinkFilter {
  private inside = false;
  private pending = '';

  feed(chunk: string): string {
    let input = this.pending + chunk;
    this.pending = '';
    let out = '';
    while (input) {
      const tag = this.inside ? '</think>' : '<think>';
      const at = input.indexOf(tag);
      if (at >= 0) {
        if (!this.inside) out += input.slice(0, at);
        input = input.slice(at + tag.length);
        this.inside = !this.inside;
        continue;
      }
      // Keep a possible partial tag for the next chunk.
      let keep = 0;
      for (let k = Math.min(tag.length - 1, input.length); k > 0; k -= 1) {
        if (tag.startsWith(input.slice(-k))) { keep = k; break; }
      }
      if (!this.inside) out += input.slice(0, input.length - keep);
      this.pending = input.slice(input.length - keep);
      input = '';
    }
    return out;
  }
}

export class OpenAICompatibleProvider implements Provider {
  constructor(readonly config: ProviderConfig) {}

  private get base(): string {
    return (this.config.baseUrl || presetFor(this.config.preset).baseUrl).replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const key = this.config.apiKey.trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    if (this.config.preset === 'openrouter') {
      headers['HTTP-Referer'] = 'https://genius.com/';
      headers['X-Title'] = 'Lyric Lens';
    }
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await streamRequest({ url: `${this.base}/models`, method: 'GET', headers: this.headers(), signal, idleTimeoutMs: 20_000 });
    if (res.status < 200 || res.status >= 300) throw classifyHttpError(res.status, res.text, res.headers);
    const data = JSON.parse(res.text) as { data?: Array<{ id: string; name?: string }>; models?: Array<{ id?: string; name?: string; model?: string }> };
    const raw = data.data ?? data.models ?? [];
    const preset = presetFor(this.config.preset);
    const recommended = preset.recommended ?? [];
    return raw
      .map((m) => {
        const id = String((m as { id?: string }).id ?? (m as { model?: string }).model ?? m.name ?? '');
        let rank = 1;
        const rec = recommended.findIndex((r) => id === r || id.endsWith(`/${r}`));
        if (rec >= 0) rank = 100 - rec;
        if (preset.id === 'openrouter') rank = id.endsWith(':free') ? Math.max(rank, 10) : 0;
        if (/whisper|tts|embed|guard|moderation|image|vision-only|audio|rerank/i.test(id)) rank = -1;
        return { id, label: (m as { name?: string }).name || id, rank };
      })
      .filter((m) => m.id && m.rank >= 0)
      .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const usesCompletionTokens = this.config.preset === 'openai' || this.config.preset === 'groq';
    try {
      return await this.generateOnce(req, usesCompletionTokens);
    } catch (error) {
      if (error instanceof LLMError && error.kind === 'bad-request' && /max_(completion_)?tokens/i.test(error.message)) {
        return this.generateOnce(req, !usesCompletionTokens);
      }
      throw error;
    }
  }

  private async generateOnce(req: GenerateRequest, completionTokens: boolean): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      stream: true,
      temperature: 0.6,
    };
    body[completionTokens ? 'max_completion_tokens' : 'max_tokens'] = req.maxOutputTokens;

    const sse = new SseParser();
    const think = new ThinkFilter();
    let text = '';
    let finishReason = '';
    let streamError: LLMError | null = null;

    const handle = (payload: string) => {
      if (payload.trim() === '[DONE]') return;
      let data: { error?: { message?: string; code?: number | string }; choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }> };
      try { data = JSON.parse(payload); } catch { return; }
      if (data.error) {
        streamError = classifyHttpError(Number(data.error.code) || 500, JSON.stringify(data));
        return;
      }
      const choice = data.choices?.[0];
      const content = choice?.delta?.content;
      if (content) {
        const visible = think.feed(content);
        if (visible) {
          text += visible;
          req.onText(visible);
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    };

    const res = await streamRequest({
      url: `${this.base}/chat/completions`,
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
      firstByteTimeoutMs: 180_000,
      idleTimeoutMs: 90_000,
      onText: (chunk) => { for (const payload of sse.feed(chunk)) handle(payload); },
    });
    for (const payload of sse.flush()) handle(payload);

    if (res.status < 200 || res.status >= 300) throw classifyHttpError(res.status, res.text, res.headers);
    if (streamError) throw streamError;
    if (!text && finishReason === 'content_filter') throw new LLMError('blocked', 'モデルが生成を止めました（content_filter）', { status: 200 });
    if (!text) throw new LLMError('empty', 'モデルから内容が返りませんでした。', { status: 200, detail: res.text.slice(0, 2000) });
    const finish = finishReason === 'stop' ? 'stop' : finishReason === 'length' ? 'length' : finishReason === 'content_filter' ? 'blocked' : 'unknown';
    return { finish, finishDetail: finishReason, text };
  }
}
