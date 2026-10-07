import {
  AVAILABILITY_CAVEAT,
  type ModelOption,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResult,
  type UsageUnits,
} from "@byoki/core";
import { CATALOG_UPDATED_AT } from "./catalog.js";
import { failedConnectionTest, providerFetch, readError, type FetchLike } from "./http.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export function createGeminiAdapter(fetchImpl: FetchLike = fetch): ProviderAdapter {
  return {
    id: "gemini",
    supportedCapabilities: ["chat", "vision"],
    testMaySpendQuota: false,
    testConnection: (key) => testKey(fetchImpl, key),
    listModels: (key) => listModels(fetchImpl, key),
    invoke: (request, key) => invoke(fetchImpl, request, key),
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

async function invoke(fetchImpl: FetchLike, request: ProviderRequest, key: string): Promise<ProviderResult> {
  const started = Date.now();
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
  const response = await providerFetch(
    fetchImpl,
    `${BASE}/models/${encodeURIComponent(request.modelId)}:generateContent`,
    {
      method: "POST",
      headers: { ...headers(key), "content-type": "application/json" },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        ...(request.maxOutputTokens !== undefined
          ? { generationConfig: { maxOutputTokens: request.maxOutputTokens } }
          : {}),
      }),
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
