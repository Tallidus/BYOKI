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

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export function createGeminiAdapter(fetchImpl: FetchLike = fetch): ProviderAdapter {
  return {
    id: "gemini",
    supportedCapabilities: ["chat", "vision"],
    testMaySpendQuota: false,
    testConnection: (key) => testKey(fetchImpl, key),
    listModels: (key) => listModels(fetchImpl, key),
    invoke: (request, key) => invoke(fetchImpl, request, key),
    invokeStream: (request, key) => invokeStream(fetchImpl, request, key),
  };
}

function headers(key: string): Record<string, string> {
  return { "x-goog-api-key": key };
}

async function testKey(fetchImpl: FetchLike, key: string) {
  const response = await providerFetch(fetchImpl, `${BASE}/models`, { method: "GET", headers: headers(key) }, 15_000);
  if (!response.ok) return failedConnectionTest(response);
  return { ok: true };
}

async function listModels(fetchImpl: FetchLike, key: string): Promise<ModelOption[]> {
  const models: ModelOption[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`${BASE}/models`);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await providerFetch(fetchImpl, url.toString(), { method: "GET", headers: headers(key) }, 15_000);
    if (!response.ok) throw errorFromUpstream(response.status, await response.text());
    const body = (await response.json()) as {
      nextPageToken?: string;
      models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
    };
    for (const item of body.models ?? []) {
      if (!item.name) continue;
      const id = item.name.replace(/^models\//, "");
      if (!isModelId(id)) continue;
      models.push({
        id,
        provider: "gemini",
        capabilities: categorizeModel("gemini", id, {
          displayName: item.displayName,
          methods: item.supportedGenerationMethods,
        }),
        displayName: item.displayName || id,
        catalogUpdatedAt: CATALOG_UPDATED_AT,
        source: "discovered",
        availabilityCaveat: AVAILABILITY_CAVEAT,
      });
    }
    if (!body.nextPageToken || body.nextPageToken === pageToken) break;
    pageToken = body.nextPageToken;
  }
  return models;
}

function generateBody(request: ProviderRequest, attempt: ParamAttempt): string {
  const system = request.input
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text))
    .join("\n");
  const contents = request.input
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: message.parts.map((part) =>
        part.type === "text"
          ? { text: part.text }
          : { inline_data: { mime_type: part.mimeType, data: part.data } },
      ),
    }));
  const generationConfig: Record<string, number> = {};
  if (
    request.maxOutputTokens !== undefined &&
    !attempt.omit.has("maxOutputTokens") &&
    !attempt.omit.has("generationConfig")
  ) {
    generationConfig.maxOutputTokens = request.maxOutputTokens;
  }
  if (request.temperature !== undefined && !attempt.omit.has("temperature") && !attempt.omit.has("generationConfig")) {
    generationConfig.temperature = request.temperature;
  }
  return JSON.stringify({
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  });
}

async function postGenerate(fetchImpl: FetchLike, request: ProviderRequest, key: string, stream: boolean): Promise<Response> {
  let attempt = initialAttempt();
  let lastText = "";
  let last: Response | undefined;
  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
    const response = await providerFetch(
      fetchImpl,
      `${BASE}/models/${encodeURIComponent(request.modelId)}:${method}`,
      {
        method: "POST",
        headers: { ...headers(key), "content-type": "application/json" },
        body: generateBody(request, attempt),
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
  const response = await postGenerate(fetchImpl, request, key, false);
  const body = (await response.json()) as {
    responseId?: string;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      cachedContentTokenCount?: number;
    };
  };
  const usage: UsageUnits = {};
  const gaps: string[] = [];
  const meta = body.usageMetadata;
  if (meta?.promptTokenCount === undefined) gaps.push("inputTokens");
  else usage.inputTokens = meta.promptTokenCount;
  if (meta?.candidatesTokenCount === undefined) gaps.push("outputTokens");
  else usage.outputTokens = meta.candidatesTokenCount;
  if (meta?.cachedContentTokenCount !== undefined) usage.cacheReadTokens = meta.cachedContentTokenCount;
  const text = (body.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
  return {
    status: "success",
    output: [{ type: "text", text }],
    ...(body.responseId ? { providerRequestId: body.responseId } : {}),
    latencyMs: Date.now() - started,
    usage,
    usageGaps: gaps,
    metadata: { gemini: { endpoint: "generateContent" } },
  };
}

async function openStream(fetchImpl: FetchLike, request: ProviderRequest, key: string) {
  let attempt = initialAttempt();
  let lastText = "";
  let lastStatus = 0;
  let lastId: string | undefined;
  for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
    const pending = await providerStream(
      fetchImpl,
      `${BASE}/models/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { ...headers(key), "content-type": "application/json" },
        body: generateBody(request, attempt),
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
    let promptTokens: number | undefined;
    let outputTokens: number | undefined;
    let cacheRead: number | undefined;
    for await (const event of readSse(pending.response)) {
      const record = readJsonRecord(event.data);
      throwProviderEventError(record);
      if (typeof record.responseId === "string") id = record.responseId;
      const candidates = record.candidates;
      const first = Array.isArray(candidates) ? candidates[0] : undefined;
      const content =
        first && typeof first === "object" && "content" in first ? (first as { content?: unknown }).content : undefined;
      const parts =
        content && typeof content === "object" && "parts" in content
          ? (content as { parts?: unknown }).parts
          : undefined;
      if (Array.isArray(parts)) {
        const piece = parts
          .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : ""))
          .filter(Boolean)
          .join("\n");
        if (piece) {
          text += piece;
          yield { type: "delta", text: piece };
        }
      }
      const meta = record.usageMetadata;
      if (meta && typeof meta === "object") {
        const usage = meta as {
          promptTokenCount?: unknown;
          candidatesTokenCount?: unknown;
          cachedContentTokenCount?: unknown;
        };
        if (typeof usage.promptTokenCount === "number") promptTokens = usage.promptTokenCount;
        if (typeof usage.candidatesTokenCount === "number") outputTokens = usage.candidatesTokenCount;
        if (typeof usage.cachedContentTokenCount === "number") cacheRead = usage.cachedContentTokenCount;
      }
    }
    const usage: UsageUnits = {};
    const gaps: string[] = [];
    if (promptTokens === undefined) gaps.push("inputTokens");
    else usage.inputTokens = promptTokens;
    if (outputTokens === undefined) gaps.push("outputTokens");
    else usage.outputTokens = outputTokens;
    if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
    yield {
      type: "done",
      output: [{ type: "text", text }],
      ...(id ? { providerRequestId: id } : {}),
      latencyMs: Date.now() - started,
      usage,
      usageGaps: gaps,
      metadata: { gemini: { endpoint: "streamGenerateContent" } },
    };
  } finally {
    pending.release();
  }
}
