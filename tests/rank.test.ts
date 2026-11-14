import './setup';

import { describe, expect, it } from 'vitest';
import { rankGeminiModel } from '../src/llm/gemini';
import { selectCandidates } from '../src/llm/chain';

describe('rankGeminiModel', () => {
  it('ranks Gemini 4 Hydrogen as the newest Flash', () => {
    expect(rankGeminiModel('gemini-4-hydrogen')).toBeGreaterThan(rankGeminiModel('gemini-3.8-flash'));
    expect(rankGeminiModel('gemini-4-hydrogen')).toBeGreaterThanOrEqual(1000);
  });

  it('never auto-picks the paid-only models', () => {
    for (const id of ['gemini-4-argon', 'gemini-4-carbon', 'gemini-3.1-pro-preview', 'gemini-decision-1']) {
      expect(rankGeminiModel(id)).toBe(0);
    }
  });

  it('keeps Hydrogen in the Flash slots, ahead of Flash-Lite', () => {
    const ids = ['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];
    expect(selectCandidates(ids)).toEqual(ids);
  });
});
