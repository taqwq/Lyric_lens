export type ProviderKind = 'gemini' | 'openai';

export type ThinkingLevel = 'low' | 'medium' | 'high';

/** One configured API endpoint. The list order in settings is the fallback order. */
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  /** Preset id from PRESETS (gemini, groq, cerebras, openrouter, mistral, ollama, custom). */
  preset: string;
  baseUrl: string;
  apiKey: string;
  /** Empty string = choose automatically from the provider's model list. */
  model: string;
  enabled: boolean;
}

export interface GenerateRequest {
  system: string;
  user: string;
  model: string;
  maxOutputTokens: number;
  thinking: ThinkingLevel;
  signal?: AbortSignal;
  /** Receives visible answer text incrementally (never reasoning/thought text). Returns
   *  true once the text so far contains usable output (the chain then keeps this attempt
   *  even if the stream breaks later). */
  onText: (chunk: string) => boolean | void;
}

export interface GenerateResult {
  /** Normalized stop reason. 'stop' = finished normally. */
  finish: 'stop' | 'length' | 'blocked' | 'unknown';
  finishDetail: string;
  text: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Higher = tried earlier in auto mode. */
  rank: number;
}

export interface Provider {
  readonly config: ProviderConfig;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
