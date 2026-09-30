import type { ProviderAdapter, ProviderId } from "@byoki/core";
import { createAnthropicAdapter } from "./anthropic.js";
import { createGeminiAdapter } from "./gemini.js";
import { createOpenAIAdapter } from "./openai.js";
import type { FetchLike } from "./http.js";

export { MANUAL_CATALOG, PROVIDER_LINKS, CATALOG_UPDATED_AT } from "./catalog.js";
export { createOpenAIAdapter } from "./openai.js";
export { createAnthropicAdapter } from "./anthropic.js";
export { createGeminiAdapter } from "./gemini.js";

export function createProviderAdapters(fetchImpl?: FetchLike): Record<ProviderId, ProviderAdapter> {
  return {
    openai: createOpenAIAdapter(fetchImpl),
    anthropic: createAnthropicAdapter(fetchImpl),
    gemini: createGeminiAdapter(fetchImpl),
  };
}
