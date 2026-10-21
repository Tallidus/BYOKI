import {
  AVAILABILITY_CAVEAT,
  categorizeModel,
  isModelId,
  type ModelOption,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResult,
  type ProviderStreamEvent,
  type UsageUnits,
} from "@byoki/core";
import { CATALOG_UPDATED_AT } from "./catalog.js";
import {
  errorFromUpstream,
  failedConnectionTest,
  providerFetch,
  providerStream,
  readError,
  readJsonRecord,
  readSse,
  throwProviderEventError,
  type FetchLike,
} from "./http.js";
import { initialAttempt, nextAttempt, type ParamAttempt } from "./retry.js";

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
  return (body.data ?? []).flatMap((item) => {
    if (typeof item.id !== "string" || !isModelId(item.id)) return [];
    return [discovered(item.id, categorizeModel("openai", item.id))];
  });
}

function chatBody(request: ProviderRequest, stream: boolean, attempt: ParamAttempt): string {
  const payload: Record<string, unknown> = {
    model: request.modelId,
    messages: request.input.map((message) => ({
      role: message.role,
      content: message.parts.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
      ),
    })),
  };
  if (request.maxOutputTokens !== undefined && !attempt.omit.has(attempt.tokenField)) {
    payload[attempt.tokenField] = request.maxOutputTokens;
  }
  if (request.temperature !== undefined && !attempt.omit.has("temperature")) {
    payload.temperature = request.temperature;
  }
  if (stream) {
    payload.stream = true;
    if (!attempt.omit.has("stream_options")) payload.stream_options = { include_usage: true };
  }
  return JSON.stringify(payload);
}

async function postChat(
  fetchImpl: FetchLike,
  request: ProviderRequest,
  key: string,
  stream: boolean,
): Promise<Response> {
  let attempt = initialAttempt();
  let last: Response | undefined;
  let lastText = "";
  for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
    const response = await providerFetch(
      fetchImpl,
      `${BASE}/chat/completions`,
      {
        method: "POST",
        headers: { ...auth(key), "content-type": "application/json" },
        body: chatBody(request, stream, attempt),
      },
      request.timeoutMs,
    );
    if (response.ok) return response;
    last = response;
    lastText = await response.text();
    const retry = nextAttempt(attempt, lastText);
    if (!retry) break;
    attempt = retry;
  }
  const requestId = last?.headers.get("x-request-id") ?? last?.headers.get("request-id") ?? undefined;
  throw errorFromUpstream(last?.status ?? 0, lastText, requestId);
}

async function invoke(fetchImpl: FetchLike, request: ProviderRequest, key: string): Promise<ProviderResult> {
  const started = Date.now();
  const response = await postChat(fetchImpl, request, key, false);
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
  const pending = await openStream(fetchImpl, request, key);
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

async function openStream(fetchImpl: FetchLike, request: ProviderRequest, key: string) {
  let attempt = initialAttempt();
  let lastText = "";
  let lastStatus = 0;
  let lastId: string | undefined;
  for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
    const pending = await providerStream(
      fetchImpl,
      `${BASE}/chat/completions`,
      {
        method: "POST",
        headers: { ...auth(key), "content-type": "application/json" },
        body: chatBody(request, true, attempt),
      },
      request.timeoutMs,
    );
    if (pending.response.ok) return pending;
    lastStatus = pending.response.status;
    lastId = pending.response.headers.get("x-request-id") ?? pending.response.headers.get("request-id") ?? undefined;
    lastText = await pending.response.text();
    pending.release();
    const retry = nextAttempt(attempt, lastText);
    if (!retry) break;
    attempt = retry;
  }
  throw errorFromUpstream(lastStatus, lastText, lastId);
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

function discovered(id: string, capabilities: ModelOption["capabilities"]): ModelOption {
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
