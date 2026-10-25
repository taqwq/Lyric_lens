import type { ProviderKind } from './types';

export interface Preset {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  keyUrl?: string;
  /** Preferred models for automatic selection, matched against the live model list. */
  recommended?: string[];
  hint: string;
}

/* Every preset here has a free tier (or runs locally). Model names change often, so the
 * live /models list is the source of truth; `recommended` only orders it. */
export const PRESETS: Preset[] = [
  {
    id: 'gemini',
    kind: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    hint: '無料枠あり。訳の質が最も安定。',
  },
  {
    id: 'groq',
    kind: 'openai',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    recommended: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905', 'moonshotai/kimi-k2-instruct', 'qwen/qwen3-32b', 'llama-3.3-70b-versatile'],
    hint: '無料枠あり。非常に速い。',
  },
  {
    id: 'cerebras',
    kind: 'openai',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    needsKey: true,
    keyUrl: 'https://cloud.cerebras.ai/',
    recommended: ['gpt-oss-120b', 'qwen-3-235b-a22b-instruct-2507', 'llama-3.3-70b'],
    hint: '無料枠あり。速い。',
  },
  {
    id: 'openrouter',
    kind: 'openai',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    hint: '「:free」付きモデルは無料（1日の回数は少なめ）。',
  },
  {
    id: 'mistral',
    kind: 'openai',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    recommended: ['mistral-medium-latest', 'mistral-small-latest'],
    hint: '無料の Experiment プランあり。',
  },
  {
    id: 'ollama',
    kind: 'openai',
    label: 'Ollama（ローカル）',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    hint: '自分のPCで動かすモデル。回数制限なし。',
  },
  {
    id: 'custom',
    kind: 'openai',
    label: 'その他（OpenAI 互換）',
    baseUrl: '',
    needsKey: false,
    hint: 'OpenAI 互換 API のベース URL を指定。',
  },
];

export function presetFor(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1]!;
}
