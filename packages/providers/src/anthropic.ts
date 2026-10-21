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
  readJsonRecord,
  readSse,
  throwProviderEventError,
  type FetchLike,
} from "./http.js";
import { initialAttempt, nextAttempt, type ParamAttempt } from "./retry.js";

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
    invokeStream: (request, key) => invokeStream(fetchImpl, request, key),
  };
}

function headers(key: string): Record<string, string> {
  return {
    "x-api-key": key,
    "anthropic-version": VERSION,
    // Browsers are blocked unless this header is on the request. Native clients ignore it.
    "anthropic-dangerous-direct-browser-access": "true",
  };
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
  const models: ModelOption[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`${BASE}/models`);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after_id", after);
    const response = await providerFetch(fetchImpl, url.toString(), { method: "GET", headers: headers(key) }, 15_000);
    if (!response.ok) throw errorFromUpstream(response.status, await response.text());
    const body = (await response.json()) as {
      has_more?: boolean;
      last_id?: string;
      data?: Array<{ id?: string; display_name?: string; capabilities?: { image_input?: { supported?: boolean } } }>;
    };
    for (const item of body.data ?? []) {
      if (typeof item.id !== "string" || !isModelId(item.id)) continue;
      const imageInput = item.capabilities?.image_input?.supported;
      models.push({
        id: item.id,
        provider: "anthropic",
        capabilities: categorizeModel("anthropic", item.id, {
          displayName: item.display_name,
          ...(typeof imageInput === "boolean" ? { imageInput } : {}),
        }),
        displayName: item.display_name || item.id,
        catalogUpdatedAt: CATALOG_UPDATED_AT,
        source: "discovered",
        availabilityCaveat: AVAILABILITY_CAVEAT,
      });
    }
    if (!body.has_more || typeof body.last_id !== "string" || body.last_id === after) break;
    after = body.last_id;
  }
  return models;
}

function messageBody(request: ProviderRequest, stream: boolean, attempt: ParamAttempt): string {
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
  return JSON.stringify({
    model: request.modelId,
    ...(attempt.omit.has("max_tokens") ? {} : { max_tokens: request.maxOutputTokens ?? 1024 }),
    ...(request.temperature !== undefined && !attempt.omit.has("temperature")
      ? { temperature: request.temperature }
      : {}),
    ...(system ? { system } : {}),
    messages,
    ...(stream ? { stream: true } : {}),
  });
}

async function postMessages(fetchImpl: FetchLike, request: ProviderRequest, key: string, stream: boolean): Promise<Response> {
  let attempt = initialAttempt();
  let lastText = "";
  let last: Response | undefined;
  for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
    const response = await providerFetch(
      fetchImpl,
      `${BASE}/messages`,
      {
        method: "POST",
        headers: { ...headers(key), "content-type": "application/json" },
        body: messageBody(request, stream, attempt),
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
  const response = await postMessages(fetchImpl, request, key, false);
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
  const text = (body.content ?? [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
  return finishAnthropic(started, text, body.id, body.usage, false);
}

async function* invokeStream(
  fetchImpl: FetchLike,
  request: ProviderRequest,
  key: string,
): AsyncGenerator<ProviderStreamEvent> {
  const started = Date.now();
  const pending = await openStream(fetchImpl, request, key);
  try {
    let text = "";
    let id: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cacheRead: number | undefined;
    let cacheWrite: number | undefined;
    for await (const event of readSse(pending.response)) {
      const record = readJsonRecord(event.data);
      throwProviderEventError(record);
      if (event.event === "message_start" || record.type === "message_start") {
        const message = record.message;
        if (message && typeof message === "object") {
          const fields = message as { id?: unknown; usage?: Record<string, unknown> };
          if (typeof fields.id === "string") id = fields.id;
          if (typeof fields.usage?.input_tokens === "number") inputTokens = fields.usage.input_tokens;
          if (typeof fields.usage?.cache_read_input_tokens === "number") cacheRead = fields.usage.cache_read_input_tokens;
          if (typeof fields.usage?.cache_creation_input_tokens === "number") {
            cacheWrite = fields.usage.cache_creation_input_tokens;
          }
        }
      }
      const delta = record.delta;
      if (delta && typeof delta === "object" && (delta as { type?: unknown }).type === "text_delta") {
        const piece = (delta as { text?: unknown }).text;
        if (typeof piece === "string" && piece.length > 0) {
          text += piece;
          yield { type: "delta", text: piece };
        }
      }
      if (event.event === "message_delta" || record.type === "message_delta") {
        const usage = record.usage;
        if (usage && typeof usage === "object" && typeof (usage as { output_tokens?: unknown }).output_tokens === "number") {
          outputTokens = (usage as { output_tokens: number }).output_tokens;
        }
      }
    }
    const usage = {
      ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
      ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
      ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cache_creation_input_tokens: cacheWrite } : {}),
    };
    const done = finishAnthropic(started, text, id, usage, true);
    yield {
      type: "done",
      output: done.output,
      ...(done.providerRequestId ? { providerRequestId: done.providerRequestId } : {}),
      latencyMs: done.latencyMs,
      ...(done.usage ? { usage: done.usage } : {}),
      usageGaps: done.usageGaps,
      ...(done.metadata ? { metadata: done.metadata } : {}),
    };
  } finally {
    pending.release();
  }
}

async function openStream(fetchImpl: FetchLike, request: ProviderRequest, key: string) {
  let attempt = initialAttempt();
  let lastText = "";
  let lastStatus = 0;
  let lastId: string | undefined;
  for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
    const pending = await providerStream(
      fetchImpl,
      `${BASE}/messages`,
      {
        method: "POST",
        headers: { ...headers(key), "content-type": "application/json" },
        body: messageBody(request, true, attempt),
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

function finishAnthropic(
  started: number,
  text: string,
  id: string | undefined,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | undefined,
  stream: boolean,
): ProviderResult {
  const mapped: UsageUnits = {};
  const gaps: string[] = [];
  if (usage?.input_tokens === undefined) gaps.push("inputTokens");
  else mapped.inputTokens = usage.input_tokens;
  if (usage?.output_tokens === undefined) gaps.push("outputTokens");
  else mapped.outputTokens = usage.output_tokens;
  if (usage?.cache_read_input_tokens !== undefined) mapped.cacheReadTokens = usage.cache_read_input_tokens;
  if (usage?.cache_creation_input_tokens !== undefined) mapped.cacheWriteTokens = usage.cache_creation_input_tokens;
  return {
    status: "success",
    output: [{ type: "text", text }],
    ...(id ? { providerRequestId: id } : {}),
    latencyMs: Date.now() - started,
    usage: mapped,
    usageGaps: gaps,
    metadata: stream ? { anthropic: { endpoint: "messages", stream: true } } : { anthropic: { endpoint: "messages" } },
  };
}
