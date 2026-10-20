import type { Usage } from './types.js';

/**
 * Published list prices in USD per million tokens, captured on 2026-10-20.
 *
 * Sources:
 * - OpenRouter `/api/v1/models` for `~deepseek/deepseek-flash-latest`
 * - The installed pi-ai catalogs for deepseek-official and opencode-go
 *
 * These are estimates: they exclude taxes, discounts and provider rounding.
 * Update this table when a provider changes prices.
 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICING: Record<string, ModelPricing> = {
  'openrouter:~deepseek/deepseek-flash-latest': {
    input: 0.07,
    output: 0.5,
    cacheRead: 0.008,
    cacheWrite: 0,
  },
  'deepseek-official:deepseek-flash': {
    input: 0.3,
    output: 1.2,
    cacheRead: 0.006,
    cacheWrite: 0,
  },
  'opencode-go:deepseek-v4.1-flash': {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.003,
    cacheWrite: 0,
  },
  'opencode-go:glm-5.3-flash': {
    input: 0.15,
    output: 0.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  },
};

/**
 * Estimate one run's USD cost from its token usage. Returns undefined when the
 * provider/model is unknown, so the UI can show "n/d" instead of a fake zero.
 */
export function estimateCostUsd(
  provider: string | undefined,
  model: string | undefined,
  usage: Usage | undefined,
): number | undefined {
  if (!provider || !model || !usage) return undefined;
  const rates = PRICING[`${provider}:${model}`];
  if (!rates) return undefined;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return (
    (input * rates.input +
      output * rates.output +
      cacheRead * rates.cacheRead +
      cacheWrite * rates.cacheWrite) /
    1_000_000
  );
}
