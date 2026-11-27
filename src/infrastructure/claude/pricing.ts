import type { Usage } from "../../domain/deliberation/model.js";

interface ModelPrice {
  /** USD per million tokens. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

/** First-party list prices (USD per million tokens). Cache writes cost 1.25x input. */
const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenCounts {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

/** Converts API token counts into the domain's Usage. Unknown models are counted with zero cost. */
export function usageOf(model: string, counts: TokenCounts): Usage {
  const price = PRICES[model];
  const cacheWrite = counts.cache_creation_input_tokens ?? 0;
  const cacheRead = counts.cache_read_input_tokens ?? 0;
  const costUsd = price
    ? (counts.input_tokens * price.input +
        cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
        cacheRead * price.cacheRead +
        counts.output_tokens * price.output) /
      1_000_000
    : 0;
  return {
    inputTokens: counts.input_tokens + cacheWrite + cacheRead,
    outputTokens: counts.output_tokens,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
  };
}
