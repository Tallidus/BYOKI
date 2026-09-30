import { AVAILABILITY_CAVEAT, type ModelOption, type ProviderId } from "@byoki/core";

export const CATALOG_UPDATED_AT = "2026-09-25T00:00:00.000Z";

export const MANUAL_CATALOG: ModelOption[] = [
  model("openai", "gpt-5.6-terra", "GPT-5.6 Terra", ["chat", "vision"]),
  model("openai", "gpt-5.6-luna", "GPT-5.6 Luna", ["chat", "vision"]),
  model("anthropic", "claude-sonnet-5", "Claude Sonnet 5", ["chat", "vision"]),
  model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", ["chat", "vision"]),
  model("gemini", "gemini-3.5-flash", "Gemini 3.5 Flash", ["chat", "vision"]),
  model("gemini", "gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite", ["chat", "vision"]),
];

function model(
  provider: ProviderId,
  id: string,
  displayName: string,
  capabilities: ModelOption["capabilities"],
): ModelOption {
  return {
    id,
    provider,
    capabilities,
    displayName,
    catalogUpdatedAt: CATALOG_UPDATED_AT,
    source: "catalog",
    availabilityCaveat: AVAILABILITY_CAVEAT,
  };
}

export const PROVIDER_LINKS = {
  openai: {
    keys: "https://platform.openai.com/api-keys",
    usage: "https://platform.openai.com/usage",
    billing: "https://platform.openai.com/settings/organization/billing",
    reviewedAt: "2026-09-25",
  },
  anthropic: {
    keys: "https://platform.claude.com/settings/keys",
    usage: "https://platform.claude.com/usage",
    billing: "https://platform.claude.com/settings/billing",
    reviewedAt: "2026-09-25",
  },
  gemini: {
    keys: "https://aistudio.google.com/apikey",
    usage: "https://aistudio.google.com/usage",
    billing: "https://console.cloud.google.com/billing",
    reviewedAt: "2026-09-25",
  },
} as const;
