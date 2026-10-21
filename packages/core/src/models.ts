import type { Capability, ModelOption, ProviderId, RecommendedModel } from "./types.js";
import { CAPABILITIES } from "./types.js";

/** Model ids accepted on the wire and in local storage names. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function isModelId(value: string): boolean {
  return MODEL_ID_PATTERN.test(value);
}

/** Local storage name for a one-time acknowledgment of a non-recommended model. */
export function modelAckName(provider: ProviderId, modelId: string): string {
  return `byoki.v1.ack.${provider}.${modelId}`;
}

export type ModelListMetadata = {
  displayName?: string;
  /**
   * Provider-reported image input. `false` blocks the vision heuristic.
   * Omit it when the provider did not say.
   */
  imageInput?: boolean;
  /** Gemini `supportedGenerationMethods` and similar lists. */
  methods?: string[];
};

/**
 * Capability tags for a model the user's key can access.
 * Provider metadata wins. Name heuristics fill what the list endpoint leaves out.
 * A model may have several tags. An unrecognized id has none.
 */
export function categorizeModel(provider: ProviderId, id: string, metadata: ModelListMetadata = {}): Capability[] {
  const idLower = id.toLowerCase();
  const methods = new Set((metadata.methods ?? []).map((method) => method.toLowerCase()));
  const embedding = /embed/.test(idLower) || [...methods].some((method) => method.includes("embed"));
  const audioOnly = /whisper|transcri|^tts-|^tts$/.test(idLower) || idLower === "tts-1";
  const audio =
    audioOnly ||
    /(^|[^a-z])(audio|speech|realtime)([^a-z]|$)|-tts$/.test(idLower) ||
    [...methods].some((method) => method.includes("bidigenerate"));
  const imageGen =
    /(dall-e|dalle|gpt-image|imagen|flash-image|image-preview)/.test(idLower) ||
    /-image($|-)/.test(idLower) ||
    [...methods].some((method) => method.includes("generateimage"));
  const methodChat = methods.has("generatecontent") || methods.has("streamgeneratecontent");
  const chatFamily =
    (provider === "openai" && /^(gpt-|o[0-9]|chatgpt-)/.test(idLower) && !idLower.startsWith("gpt-image")) ||
    (provider === "anthropic" && idLower.startsWith("claude")) ||
    (provider === "gemini" && /^(gemini|gemma|learnlm)/.test(idLower));
  const exclusive = embedding || audioOnly || (imageGen && !methodChat && provider !== "gemini");

  const caps = new Set<Capability>();
  if (embedding) caps.add("embedding");
  if (audio) caps.add("audio");
  if (imageGen) caps.add("image");
  if (!exclusive && (chatFamily || methodChat) && !(imageGen && !methodChat && provider !== "gemini")) {
    caps.add("chat");
  }

  if (metadata.imageInput === true) {
    caps.add("vision");
  } else if (metadata.imageInput !== false && caps.has("chat") && !embedding && !audioOnly) {
    if (/vision/.test(idLower)) caps.add("vision");
    if (provider === "openai" && /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o[3-9]|chatgpt-4o)/.test(idLower)) {
      caps.add("vision");
    }
    if (provider === "gemini") caps.add("vision");
    if (provider === "anthropic") caps.add("vision");
  }

  return CAPABILITIES.filter((capability) => caps.has(capability));
}

export type ModelDiscovery = {
  models: ModelOption[];
  source: "discovered" | "catalog";
  /** True when the provider list failed and the developer catalog was used. */
  fallback: boolean;
};

/** Non-cryptographic session cache identity. The raw key is not stored. */
export function keyFingerprint(apiKey: string): string {
  let hash = 5381;
  for (let index = 0; index < apiKey.length; index += 1) {
    hash = ((hash << 5) + hash) ^ apiKey.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

export function partitionModels<T extends { provider: ProviderId; id: string }>(
  models: T[],
  recommended: readonly RecommendedModel[] | undefined,
): { recommended: T[]; available: T[] } {
  const wanted = recommended ?? [];
  const recommendedRows: T[] = [];
  const used = new Set<string>();
  for (const item of wanted) {
    const match = models.find((model) => model.provider === item.provider && model.id === item.modelId);
    if (!match) continue;
    const key = `${match.provider}:${match.id}`;
    if (used.has(key)) continue;
    used.add(key);
    recommendedRows.push(match);
  }
  return {
    recommended: recommendedRows,
    available: models.filter((model) => !used.has(`${model.provider}:${model.id}`)),
  };
}

export function isRecommendedModel(
  recommended: readonly RecommendedModel[] | undefined,
  provider: ProviderId,
  modelId: string,
): boolean {
  return (recommended ?? []).some((item) => item.provider === provider && item.modelId === modelId);
}

/**
 * True when a provider error body says this model cannot do the requested task.
 * Parameter incompatibilities are not task mismatches. The provider text is not returned.
 */
export function isTaskMismatchBody(body: string): boolean {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown } };
    const error = parsed?.error;
    if (error && typeof error === "object") {
      const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
      if (code === "unsupported_parameter" || code === "unsupported_value") return false;
      if (typeof error.message === "string") message = error.message;
    }
  } catch {
    message = body;
  }
  return [
    /does not support image/i,
    /image_url is only supported/i,
    /not a chat model/i,
    /only supports? embed/i,
    /cannot be used with (?:the )?(?:chat completions|messages|generatecontent)/i,
    /model does not support/i,
    /not supported for (?:chat|text)/i,
  ].some((pattern) => pattern.test(message));
}

/** Prefer the developer display name and keep every capability either side reported. */
export function mergeDiscoveredModels(discovered: ModelOption[], catalog: ModelOption[]): ModelOption[] {
  return discovered.map((model) => {
    const known = catalog.find((item) => item.provider === model.provider && item.id === model.id);
    if (!known) return model;
    const capabilities = CAPABILITIES.filter(
      (capability) => model.capabilities.includes(capability) || known.capabilities.includes(capability),
    );
    return { ...model, displayName: known.displayName, capabilities };
  });
}
