import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UPSTREAM_ERROR_MESSAGES, detectProvider } from "@byoki/core";
import { MANUAL_CATALOG } from "../src/catalog.js";

const root = new URL("../../../spec/", import.meta.url);

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(name, root), "utf8")) as Record<string, unknown>;
}

describe("on-device spec data", () => {
  it("matches the shipped catalog and the fixed error sentences", () => {
    const catalog = readJson("catalog.json");
    const models = catalog.models as Array<{
      id: string;
      provider: string;
      displayName: string;
      capabilities: string[];
    }>;
    expect(catalog.updatedAt).toBe("2026-09-25T00:00:00.000Z");
    expect(
      MANUAL_CATALOG.map((model) => ({
        id: model.id,
        provider: model.provider,
        displayName: model.displayName,
        capabilities: model.capabilities,
      })),
    ).toEqual(models);

    const errors = readJson("errors.json");
    expect(errors.messages).toEqual(UPSTREAM_ERROR_MESSAGES);
  });

  it("detects keys in the spec order", () => {
    const providers = readJson("providers.json");
    const detection = providers.keyDetection as Array<{ prefix: string; provider: "openai" | "anthropic" | "gemini" }>;
    expect(detection.map((item) => item.prefix)).toEqual(["sk-ant-", "sk-", "AIza"]);
    for (const item of detection) {
      expect(detectProvider(`${item.prefix}example`)).toBe(item.provider);
    }
    expect(detectProvider("sk-ant-example")).toBe("anthropic");
  });
});
