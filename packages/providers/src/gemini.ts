import {
  AVAILABILITY_CAVEAT,
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
  const response = await providerFetch(fetchImpl, `${BASE}/models`, { method: "GET", headers: headers(key) }, 15_000);
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as {
    models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  };
  return (body.models ?? [])
    .filter((item) => item.supportedGenerationMethods?.includes("generateContent") && item.name)
    .map((item) => {
      const id = item.name!.replace(/^models\//, "");
      const specialized = /image|tts|live|transcribe|embed/i.test(id);
      const capabilities: Array<"chat" | "vision"> = specialized ? [] : ["chat", "vision"];
      return {
        id,
        provider: "gemini" as const,
        capabilities,
        displayName: item.displayName || id,
        catalogUpdatedAt: CATALOG_UPDATED_AT,
        source: "discovered" as const,
        availabilityCaveat: AVAILABILITY_CAVEAT,
      };
    })
    .filter((item) => item.capabilities.length > 0);
}

function generateBody(request: ProviderRequest): string {
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
  return JSON.stringify({
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(request.maxOutputTokens !== undefined
      ? { generationConfig: { maxOutputTokens: request.maxOutputTokens } }
      : {}),
  });
}

async function invoke(fetchImpl: FetchLike, request: ProviderRequest, key: string): Promise<ProviderResult> {
  const started = Date.now();
  const response = await providerFetch(
    fetchImpl,
    `${BASE}/models/${encodeURIComponent(request.modelId)}:generateContent`,
    {
      method: "POST",
      headers: { ...headers(key), "content-type": "application/json" },
      body: generateBody(request),
    },
    request.timeoutMs,
  );
  if (!response.ok) throw await readError(response);
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

async function* invokeStream(
  fetchImpl: FetchLike,
  request: ProviderRequest,
  key: string,
): AsyncGenerator<ProviderStreamEvent> {
  const started = Date.now();
  const pending = await providerStream(
    fetchImpl,
    `${BASE}/models/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { ...headers(key), "content-type": "application/json" },
      body: generateBody(request),
    },
    request.timeoutMs,
  );
  try {
    if (!pending.response.ok) throw await readError(pending.response);
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
