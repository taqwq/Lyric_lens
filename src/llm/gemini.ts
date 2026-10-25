import { streamRequest } from '../platform/http';
import { LLMError, classifyHttpError } from './errors';
import { SseParser } from './sse';
import type { GenerateRequest, GenerateResult, ModelInfo, Provider, ProviderConfig, ThinkingLevel } from './types';

const SAFETY_OFF = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map((category) => ({ category, threshold: 'BLOCK_NONE' }));

const BLOCKED_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'OTHER', 'IMAGE_SAFETY']);

const EXCLUDED = /(tts|image|imagen|live|transcribe|embedding|robotics|computer-use|customtools|nano-banana|omni|audio|aqa|deep-research|antigravity|lyria|veo|learnlm)/i;

/** Orders models for automatic selection: newest Flash first, then Flash-Lite, then Gemma.
 *  Pro models are paid-only on the free tier, so they are listed but never auto-picked. */
export function rankGeminiModel(id: string): number {
  if (EXCLUDED.test(id) || /latest/.test(id)) return -1;
  const version = Number(/(?:gemini|gemma)-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  const preview = /preview|exp/.test(id) ? 3 : 0;
  if (id.startsWith('gemma-')) return 1 + version / 100;
  if (/-pro\b/.test(id) || /argon/.test(id)) return 0;
  if (/flash-lite/.test(id)) return 100 + version * 10 - preview;
  if (/flash/.test(id)) return 1000 + version * 10 - preview;
  return 0;
}

function thinkingConfig(model: string, level: ThinkingLevel): Record<string, unknown> | null {
  if (model.startsWith('gemma-')) return null;
  const version = Number(/gemini-(\d+(?:\.\d+)?)/.exec(model)?.[1] ?? 0);
  if (version >= 3) return { thinkingLevel: level };
  if (version >= 2.5) return { thinkingBudget: level === 'low' ? 1024 : level === 'medium' ? 4096 : 12000 };
  return null;
}

export class GeminiProvider implements Provider {
  constructor(readonly config: ProviderConfig) {}

  private get base(): string {
    return (this.config.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-goog-api-key': this.config.apiKey.trim() };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await streamRequest({ url: `${this.base}/v1beta/models?pageSize=1000`, method: 'GET', headers: this.headers(), signal, idleTimeoutMs: 20_000 });
    if (res.status < 200 || res.status >= 300) throw classifyHttpError(res.status, res.text, res.headers);
    const data = JSON.parse(res.text) as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => {
        const id = m.name.replace(/^models\//, '');
        return { id, label: m.displayName || id, rank: rankGeminiModel(id) };
      })
      .filter((m) => m.rank >= 0)
      .sort((a, b) => b.rank - a.rank);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      return await this.generateOnce(req, true);
    } catch (error) {
      // Some models reject thinking settings; retry once without them rather than skipping the model.
      if (error instanceof LLMError && error.kind === 'bad-request' && /thinking/i.test(error.message)) {
        return this.generateOnce(req, false);
      }
      throw error;
    }
  }

  private async generateOnce(req: GenerateRequest, withThinking: boolean): Promise<GenerateResult> {
    const gemma = req.model.startsWith('gemma-');
    const thinking = withThinking ? thinkingConfig(req.model, req.thinking) : null;
    // Thinking tokens count against the output cap; a fixed budget must not eat the answer.
    const budget = typeof thinking?.thinkingBudget === 'number' ? thinking.thinkingBudget : 0;
    const generationConfig: Record<string, unknown> = { maxOutputTokens: Math.min(65_536, req.maxOutputTokens + budget) };
    if (thinking) generationConfig.thinkingConfig = thinking;
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: gemma ? `${req.system}\n\n---\n\n${req.user}` : req.user }] }],
      generationConfig,
      safetySettings: SAFETY_OFF,
    };
    if (!gemma) body.systemInstruction = { parts: [{ text: req.system }] };

    const sse = new SseParser();
    let text = '';
    let finishReason = '';
    let blockReason = '';
    let streamError: LLMError | null = null;

    const handle = (payload: string) => {
      let data: {
        error?: { message?: string; code?: number; status?: string };
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
        promptFeedback?: { blockReason?: string };
      };
      try { data = JSON.parse(payload); } catch { return; }
      if (data.error) {
        streamError = classifyHttpError(Number(data.error.code) || 500, JSON.stringify(data));
        return;
      }
      if (data.promptFeedback?.blockReason) blockReason = data.promptFeedback.blockReason;
      const cand = data.candidates?.[0];
      for (const part of cand?.content?.parts ?? []) {
        if (part.thought || !part.text) continue;
        text += part.text;
        req.onText(part.text);
      }
      if (cand?.finishReason) finishReason = cand.finishReason;
    };

    const res = await streamRequest({
      url: `${this.base}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`,
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
      firstByteTimeoutMs: 90_000,
      idleTimeoutMs: 90_000,
      onText: (chunk) => { for (const payload of sse.feed(chunk)) handle(payload); },
    });
    for (const payload of sse.flush()) handle(payload);

    if (res.status < 200 || res.status >= 300) throw classifyHttpError(res.status, res.text, res.headers);
    if (streamError) throw streamError;
    if (blockReason) throw new LLMError('blocked', `Gemini が入力を処理しませんでした（${blockReason}）`, { status: 200 });
    if (!text && BLOCKED_REASONS.has(finishReason)) {
      throw new LLMError('blocked', `Gemini が生成を止めました（${finishReason}）`, { status: 200 });
    }
    if (!text) throw new LLMError('empty', 'Gemini から内容が返りませんでした。', { status: 200, detail: res.text.slice(0, 2000) });

    const finish = finishReason === 'STOP' ? 'stop'
      : finishReason === 'MAX_TOKENS' ? 'length'
      : BLOCKED_REASONS.has(finishReason) ? 'blocked'
      : 'unknown';
    return { finish, finishDetail: finishReason, text };
  }
}
