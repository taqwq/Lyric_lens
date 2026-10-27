export interface GenerateRequest {
  system: string;
  user: string;
  model: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** How long this attempt may stay silent before its first text; the provider's own default when unset. */
  firstTextTimeoutMs?: number;
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
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
