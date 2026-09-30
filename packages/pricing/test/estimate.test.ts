import { describe, expect, it } from "vitest";
import { estimateCost, type PriceEntry } from "../src/estimate.js";

const catalog: PriceEntry[] = [
  {
    provider: "openai",
    modelId: "priced",
    version: "test",
    currency: "USD",
    inputPerMillion: 2,
    outputPerMillion: 10,
  },
];

describe("estimateCost", () => {
  it("computes a known cost from input and output tokens", () => {
    const estimate = estimateCost(catalog, {
      provider: "openai",
      modelId: "priced",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
    });
    expect(estimate.status).toBe("known");
    expect(estimate.amount).toBe(7);
  });

  it("returns unknown when the price entry is missing", () => {
    const estimate = estimateCost(catalog, {
      provider: "openai",
      modelId: "missing",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    expect(estimate.status).toBe("unknown");
    expect(estimate.amount).toBeUndefined();
  });

  it("returns unknown when reported cache tokens have no price", () => {
    const estimate = estimateCost(catalog, {
      provider: "openai",
      modelId: "priced",
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 5 },
    });
    expect(estimate.status).toBe("unknown");
    expect(estimate.amount).toBeUndefined();
  });
});
