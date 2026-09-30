import { describe, expect, it } from "vitest";
import { defineAIConnections } from "../src/config.js";
import { AIConnectionsError } from "../src/errors.js";

describe("defineAIConnections", () => {
  it("accepts chat and vision", () => {
    const config = defineAIConnections({
      appName: "Garage Assistant",
      capabilities: {
        chat: {
          description: "Answers questions about vehicle repairs.",
          providers: ["openai", "anthropic", "gemini"],
          userCanChooseModel: true,
          required: true,
        },
        vision: {
          description: "Analyzes photos you submit.",
          providers: ["openai", "gemini"],
          required: false,
        },
      },
    });
    expect(config.capabilities.chat?.required).toBe(true);
    expect(config.capabilities.vision?.providers).toEqual(["openai", "gemini"]);
    expect(config.limits.requestTimeoutMs).toBe(30_000);
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      defineAIConnections({
        appName: "App",
        capabilities: {
          chat: {
            description: "Chat",
            providers: ["ollama" as "openai"],
          },
        },
      }),
    ).toThrow(AIConnectionsError);
  });
});
