import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../src/pricing.js';

describe('estimateCostUsd', () => {
  it('prices the OpenRouter flash usage', () => {
    const cost = estimateCostUsd('openrouter', '~deepseek/deepseek-flash-latest', {
      inputTokens: 246228,
      outputTokens: 54251,
      cacheReadTokens: 10642304,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(0.129499892, 9);
  });

  it('prices DeepSeek official tokens', () => {
    const cost = estimateCostUsd('deepseek-official', 'deepseek-flash', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1.506, 9);
  });

  it('returns undefined for an unknown provider or model', () => {
    expect(
      estimateCostUsd('unknown', 'model', { inputTokens: 1, outputTokens: 1 }),
    ).toBeUndefined();
    expect(
      estimateCostUsd('openrouter', 'unknown', { inputTokens: 1, outputTokens: 1 }),
    ).toBeUndefined();
  });

  it('returns zero for zero usage on a known route', () => {
    expect(
      estimateCostUsd('opencode-go', 'deepseek-v4.1-flash', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(0);
  });
});
