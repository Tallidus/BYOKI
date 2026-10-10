import { AIConnectionsError, UPSTREAM_ERROR_MESSAGES } from "./errors.js";
import type {
  Capability,
  ContentPart,
  InputMessage,
  ModelOption,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderResult,
  ProviderStreamEvent,
  UsageUnits,
} from "./types.js";
import { AVAILABILITY_CAVEAT } from "./types.js";

const CATALOG_UPDATED_AT = "2026-09-25T00:00:00.000Z";

export type MockAdapterOptions = {
  models?: ModelOption[];
  failWith?: "invalid_key" | "rate_limit" | "unavailable" | "model_unavailable";
  latencyMs?: number;
  usage?: UsageUnits;
  omitUsage?: boolean;
};

function defaultModels(id: ProviderId): ModelOption[] {
  return [
    {
      id: `${id}-mock-chat`,
      provider: id,
      capabilities: ["chat", "vision"],
      displayName: `${id} mock model`,
      catalogUpdatedAt: CATALOG_UPDATED_AT,
      source: "catalog",
      availabilityCaveat: AVAILABILITY_CAVEAT,
    },
  ];
}

export function normalizeInput(input: InputMessage[]): ProviderRequest["input"] {
  return input.map((message) => {
    const parts: ContentPart[] = message.parts
      ? message.parts
      : message.text !== undefined
        ? [{ type: "text", text: message.text }]
        : [];
    if (parts.length === 0) {
      throw new AIConnectionsError("INVALID_CONFIG", "Each message needs text or parts.");
    }
    return { role: message.role, parts };
  });
}

export function createMockAdapter(id: ProviderId, options: MockAdapterOptions = {}): ProviderAdapter {
  const models = options.models ?? defaultModels(id);
  return {
    id,
    supportedCapabilities: ["chat", "vision"],
    testMaySpendQuota: false,
    async testConnection(key: string) {
      if (!key || key.startsWith("bad")) {
        return { ok: false, reason: UPSTREAM_ERROR_MESSAGES.invalid_key, category: "invalid_key" };
      }
      return { ok: true };
    },
    async listModels() {
      return models;
    },
    async invoke(request: ProviderRequest): Promise<ProviderResult> {
      return mockResult(request, models, options);
    },
    async *invokeStream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      const result = await mockResult(request, models, options);
      const text = result.output
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const size = 4;
      for (let index = 0; index < text.length; index += size) {
        yield { type: "delta", text: text.slice(index, index + size) };
      }
      yield {
        type: "done",
        output: result.output,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        latencyMs: result.latencyMs,
        ...(result.usage ? { usage: result.usage } : {}),
        usageGaps: result.usageGaps,
        ...(result.metadata ? { metadata: result.metadata } : {}),
      };
    },
  };
}

function mockResult(request: ProviderRequest, models: ModelOption[], options: MockAdapterOptions): ProviderResult {
  if (options.failWith === "invalid_key") {
    throw new AIConnectionsError("INVALID_KEY", "The provider rejected this key.");
  }
  if (options.failWith === "rate_limit") {
    throw new AIConnectionsError("RATE_LIMITED", "The provider rate limit was reached.", "mock-req");
  }
  if (options.failWith === "unavailable") {
    throw new AIConnectionsError("UPSTREAM_UNAVAILABLE", "The provider did not respond.", "mock-req");
  }
  if (options.failWith === "model_unavailable" || !models.some((model) => model.id === request.modelId)) {
    throw new AIConnectionsError(
      "MODEL_UNAVAILABLE",
      "That model is not available for this account. Choose another model.",
      "mock-req",
    );
  }
  const text = request.input
    .flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text))
    .join("\n");
  const imageCount = request.input
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "image").length;
  const usage = options.omitUsage
    ? undefined
    : (options.usage ?? {
        inputTokens: 12,
        outputTokens: 8,
        imageCount: imageCount || undefined,
      });
  return {
    status: "success",
    output: [
      {
        type: "text",
        text: `mock:${request.capability}:${text}`,
      },
    ],
    providerRequestId: "mock-req",
    latencyMs: options.latencyMs ?? 1,
    ...(usage ? { usage } : {}),
    usageGaps: options.omitUsage ? ["inputTokens", "outputTokens"] : [],
    metadata: { mock: true },
  };
}

export function modelSupports(model: ModelOption, capability: Capability): boolean {
  return model.capabilities.includes(capability);
}
