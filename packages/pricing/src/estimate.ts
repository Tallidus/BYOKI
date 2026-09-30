import type { CostEstimate, ProviderId, UsageUnits } from "@byoki/core";

export type PriceEntry = {
  provider: ProviderId;
  modelId: string;
  version: string;
  currency: "USD";
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
};

export const PRICE_CATALOG_VERSION = "2026-09-25";

/**
 * Prices reviewed against public provider pages on 2026-09-25.
 * Models without an entry estimate as unknown rather than zero.
 * OpenAI figures are from the models guide. Anthropic Opus 5 and Fable 5.1
 * figures are from Anthropic's model catalog. Other models stay unpriced
 * until a reviewed entry is added.
 */
export const PRICE_CATALOG: PriceEntry[] = [
  { provider: "openai", modelId: "gpt-5.6-sol", version: PRICE_CATALOG_VERSION, currency: "USD", inputPerMillion: 4, outputPerMillion: 20 },
  { provider: "openai", modelId: "gpt-5.6-terra", version: PRICE_CATALOG_VERSION, currency: "USD", inputPerMillion: 2, outputPerMillion: 12 },
  { provider: "openai", modelId: "gpt-5.6-luna", version: PRICE_CATALOG_VERSION, currency: "USD", inputPerMillion: 0.2, outputPerMillion: 1.2 },
  { provider: "anthropic", modelId: "claude-opus-5", version: PRICE_CATALOG_VERSION, currency: "USD", inputPerMillion: 5, outputPerMillion: 25 },
  { provider: "anthropic", modelId: "claude-fable-5-1", version: PRICE_CATALOG_VERSION, currency: "USD", inputPerMillion: 10, outputPerMillion: 50, cacheReadPerMillion: 0.25 },
];

export function estimateCost(
  catalog: PriceEntry[],
  args: { provider: ProviderId; modelId: string; usage: UsageUnits | undefined },
): CostEstimate {
  const entry = catalog.find((row) => row.provider === args.provider && row.modelId === args.modelId);
  if (!entry || !args.usage) {
    return { status: "unknown", currency: "USD", ...(entry ? { catalogVersion: entry.version } : {}) };
  }
  const usage = args.usage;
  let amount = 0;
  const required: Array<["inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens", number | undefined]> = [
    ["inputTokens", entry.inputPerMillion],
    ["outputTokens", entry.outputPerMillion],
  ];
  if (usage.cacheReadTokens !== undefined) required.push(["cacheReadTokens", entry.cacheReadPerMillion]);
  if (usage.cacheWriteTokens !== undefined) required.push(["cacheWriteTokens", entry.cacheWritePerMillion]);
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return { status: "unknown", currency: "USD", catalogVersion: entry.version };
  }
  for (const [field, price] of required) {
    const units = usage[field];
    if (units === undefined) continue;
    if (price === undefined) {
      return { status: "unknown", currency: "USD", catalogVersion: entry.version };
    }
    amount += (units / 1_000_000) * price;
  }
  return { status: "known", currency: "USD", amount, catalogVersion: entry.version };
}
