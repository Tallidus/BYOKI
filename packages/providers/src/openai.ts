import {
  AVAILABILITY_CAVEAT,
  type Capability,
  type ModelOption,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResult,
  type ProviderStreamEvent,
  type UsageUnits,
} from "@byoki/core";
import { CATALOG_UPDATED_AT } from "./catalog.js";
import {
  failedConnectionTest,
  providerFetch,
  providerStream,
  readError,
  readJsonRecord,
  readSse,
  throwProviderEventError,
  type FetchLike,
} from "./http.js";

const BASE = "https://api.openai.com/v1";

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
};

export function createOpenAIAdapter(fetchImpl: FetchLike = fetch): ProviderAdapter {
  return {
    id: "openai",
    supportedCapabilities: ["chat", "vision"],
    testMaySpendQuota: false,
    testConnection: (key) => testKey(fetchImpl, key),
    listModels: (key) => listModels(fetchImpl, key),
    invoke: (request, key) => invoke(fetchImpl, request, key),
    invokeStream: (request, key) => invokeStream(fetchImpl, request, key),
  };
}

async function testKey(fetchImpl: FetchLike, key: string) {
  const response = await providerFetch(fetchImpl, `${BASE}/models`, { method: "GET", headers: auth(key) }, 15_000);
  if (!response.ok) return failedConnectionTest(response);
  return { ok: true };
}

async function listModels(fetchImpl: FetchLike, key: string): Promise<ModelOption[]> {
  const response = await providerFetch(fetchImpl, `${BASE}/models`, { method: "GET", headers: auth(key) }, 15_000);
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? [])
    .filter((item) => typeof item.id === "string" && /^(gpt-|o[0-9])/.test(item.id))
    .map((item) => discovered(item.id!, ["chat"]));
}

function chatBody(request: ProviderRequest, stream: boolean): string {
  return JSON.stringify({
    model: request.modelId,
    messages: request.input.map((message) => ({
      role: message.role,
      content: message.parts.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
      ),
    })),
    ...(request.maxOutputTokens !== undefined ? { max_completion_tokens: request.maxOutputTokens } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  });
}

async function invoke(fetchImpl: FetchLike, request: ProviderRequest, key: string): Promise<ProviderResult> {
  const started = Date.now();
  const response = await providerFetch(
    fetchImpl,
    `${BASE}/chat/completions`,
    {
      method: "POST",
      headers: { ...auth(key), "content-type": "application/json" },
      body: chatBody(request, false),
    },
    request.timeoutMs,
  );
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as {
    id?: string;
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: OpenAIUsage;
  };
  const usage = mapUsage(body.usage);
  return {
    status: "success",
    output: [{ type: "text", text: body.choices?.[0]?.message?.content ?? "" }],
    ...(body.id ? { providerRequestId: body.id } : {}),
    latencyMs: Date.now() - started,
    ...(usage.usage ? { usage: usage.usage } : {}),
    usageGaps: usage.gaps,
    metadata: { openai: { endpoint: "chat.completions" } },
  };
}

async function* invokeStream(
  fetchImpl: FetchLike,
  request: ProviderRequest,
  key: string,
): AsyncGenerator<ProviderStreamEvent> {
  const started = Date.now();
  const pending = await providerStream(
    fetchImpl,
    `${BASE}/chat/completions`,
    {
      method: "POST",
      headers: { ...auth(key), "content-type": "application/json" },
      body: chatBody(request, true),
    },
    request.timeoutMs,
  );
  try {
    if (!pending.response.ok) throw await readError(pending.response);
    let text = "";
    let id: string | undefined;
    let usage: OpenAIUsage | undefined;
    for await (const event of readSse(pending.response)) {
      if (event.data === "[DONE]") break;
      const record = readJsonRecord(event.data);
      throwProviderEventError(record);
      if (typeof record.id === "string") id = record.id;
      const choices = record.choices;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const delta =
        first && typeof first === "object" && "delta" in first && first.delta && typeof first.delta === "object"
          ? (first.delta as { content?: unknown }).content
          : undefined;
      if (typeof delta === "string" && delta.length > 0) {
        text += delta;
        yield { type: "delta", text: delta };
      }
      if (record.usage && typeof record.usage === "object") usage = record.usage as OpenAIUsage;
    }
    const mapped = mapUsage(usage);
    yield {
      type: "done",
      output: [{ type: "text", text }],
      ...(id ? { providerRequestId: id } : {}),
      latencyMs: Date.now() - started,
      ...(mapped.usage ? { usage: mapped.usage } : {}),
      usageGaps: mapped.gaps,
      metadata: { openai: { endpoint: "chat.completions", stream: true } },
    };
  } finally {
    pending.release();
  }
}

function mapUsage(usage: OpenAIUsage | undefined): { usage?: UsageUnits; gaps: string[] } {
  if (!usage) return { gaps: ["inputTokens", "outputTokens"] };
  const mapped: UsageUnits = {};
  const gaps: string[] = [];
  if (usage.prompt_tokens === undefined) gaps.push("inputTokens");
  else mapped.inputTokens = usage.prompt_tokens;
  if (usage.completion_tokens === undefined) gaps.push("outputTokens");
  else mapped.outputTokens = usage.completion_tokens;
  if (usage.prompt_tokens_details?.cached_tokens !== undefined) {
    mapped.cacheReadTokens = usage.prompt_tokens_details.cached_tokens;
  }
  if (usage.prompt_tokens_details?.cache_write_tokens !== undefined) {
    mapped.cacheWriteTokens = usage.prompt_tokens_details.cache_write_tokens;
  }
  return { usage: mapped, gaps };
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

function discovered(id: string, capabilities: Capability[]): ModelOption {
  return {
    id,
    provider: "openai",
    capabilities,
    displayName: id,
    catalogUpdatedAt: CATALOG_UPDATED_AT,
    source: "discovered",
    availabilityCaveat: AVAILABILITY_CAVEAT,
  };
}
