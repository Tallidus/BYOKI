import {
  AVAILABILITY_CAVEAT,
  type Capability,
  type ModelOption,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResult,
  type UsageUnits,
} from "@byoki/core";
import { CATALOG_UPDATED_AT } from "./catalog.js";
import { failedConnectionTest, providerFetch, readError, type FetchLike } from "./http.js";

const BASE = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";

export function createAnthropicAdapter(fetchImpl: FetchLike = fetch): ProviderAdapter {
  return {
    id: "anthropic",
    supportedCapabilities: ["chat", "vision"],
    testMaySpendQuota: false,
    testConnection: (key) => testKey(fetchImpl, key),
    listModels: (key) => listModels(fetchImpl, key),
    invoke: (request, key) => invoke(fetchImpl, request, key),
  };
}

function headers(key: string): Record<string, string> {
  return { "x-api-key": key, "anthropic-version": VERSION };
}

async function testKey(fetchImpl: FetchLike, key: string) {
  const response = await providerFetch(
    fetchImpl,
    `${BASE}/models?limit=1`,
    { method: "GET", headers: headers(key) },
    15_000,
  );
  if (!response.ok) return failedConnectionTest(response);
  return { ok: true };
}

async function listModels(fetchImpl: FetchLike, key: string): Promise<ModelOption[]> {
  const response = await providerFetch(
    fetchImpl,
    `${BASE}/models?limit=100`,
    { method: "GET", headers: headers(key) },
    15_000,
  );
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as {
    data?: Array<{ id?: string; display_name?: string; capabilities?: { image_input?: { supported?: boolean } } }>;
  };
  return (body.data ?? [])
    .filter((item) => typeof item.id === "string")
    .map((item) => {
      const capabilities: Capability[] = ["chat"];
      if (item.capabilities?.image_input?.supported) capabilities.push("vision");
      return {
        id: item.id!,
        provider: "anthropic" as const,
        capabilities,
        displayName: item.display_name || item.id!,
        catalogUpdatedAt: CATALOG_UPDATED_AT,
        source: "discovered" as const,
        availabilityCaveat: AVAILABILITY_CAVEAT,
      };
    });
}

async function invoke(fetchImpl: FetchLike, request: ProviderRequest, key: string): Promise<ProviderResult> {
  const started = Date.now();
  const system = request.input
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text))
    .join("\n");
  const messages = request.input
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.parts.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } },
      ),
    }));
  const response = await providerFetch(
    fetchImpl,
    `${BASE}/messages`,
    {
      method: "POST",
      headers: { ...headers(key), "content-type": "application/json" },
      body: JSON.stringify({
        model: request.modelId,
        max_tokens: request.maxOutputTokens ?? 1024,
        ...(system ? { system } : {}),
        messages,
      }),
    },
    request.timeoutMs,
  );
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as {
    id?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const usage: UsageUnits = {};
  const gaps: string[] = [];
  if (body.usage?.input_tokens === undefined) gaps.push("inputTokens");
  else usage.inputTokens = body.usage.input_tokens;
  if (body.usage?.output_tokens === undefined) gaps.push("outputTokens");
  else usage.outputTokens = body.usage.output_tokens;
  if (body.usage?.cache_read_input_tokens !== undefined) usage.cacheReadTokens = body.usage.cache_read_input_tokens;
  if (body.usage?.cache_creation_input_tokens !== undefined) {
    usage.cacheWriteTokens = body.usage.cache_creation_input_tokens;
  }
  const text = (body.content ?? [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
  return {
    status: "success",
    output: [{ type: "text", text }],
    ...(body.id ? { providerRequestId: body.id } : {}),
    latencyMs: Date.now() - started,
    usage,
    usageGaps: gaps,
    metadata: { anthropic: { endpoint: "messages" } },
  };
}
