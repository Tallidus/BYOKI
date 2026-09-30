import { describe, expect, it } from "vitest";
import { createProviderAdapters } from "../src/index.js";

const live = process.env.BYOKI_LIVE === "1";

describe.skipIf(!live)("live provider smoke", () => {
  it("tests OpenAI, Anthropic, and Gemini keys from the environment", async () => {
    const adapters = createProviderAdapters();
    const cases = [
      ["openai", process.env.OPENAI_API_KEY],
      ["anthropic", process.env.ANTHROPIC_API_KEY],
      ["gemini", process.env.GEMINI_API_KEY],
    ] as const;
    for (const [id, key] of cases) {
      expect(key, `${id} key`).toBeTruthy();
      const result = await adapters[id].testConnection(key!);
      expect(result.ok, result.reason).toBe(true);
    }
  });
});
