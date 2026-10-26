import { z } from "zod";
import { AIConnectionsError } from "./errors.js";
import {
  CAPABILITIES,
  PROVIDER_IDS,
  type AIConnectionsConfig,
  type Capability,
  type ProviderId,
} from "./types.js";

const providerSchema = z.enum(PROVIDER_IDS);
const capabilitySchema = z.enum(CAPABILITIES);

const modelIdSchema = z.string().regex(/^[A-Za-z0-9._:-]+$/, "Use a model id made of letters, numbers, and . _ : -");

const recommendedSchema = z.object({
  provider: providerSchema,
  modelId: modelIdSchema,
});

const policySchema = z.object({
  description: z.string().min(1),
  providers: z.array(providerSchema).min(1),
  userCanChooseModel: z.boolean().default(true),
  required: z.boolean().default(false),
  recommendedModels: z.array(recommendedSchema).optional(),
  defaultModel: recommendedSchema.optional(),
});

const inputSchema = z
  .object({
    appName: z.string().min(1),
    capabilities: z.partialRecord(capabilitySchema, policySchema),
    limits: z
      .object({
        maxOutputTokens: z.number().int().positive().optional(),
        requestTimeoutMs: z.number().int().positive().default(30_000),
        budget: z
          .object({
            warnAtUsd: z.number().nonnegative().optional(),
            blockAtUsd: z.number().nonnegative().optional(),
          })
          .optional(),
      })
      .prefault({}),
  })
  .superRefine((value, ctx) => {
    const names = Object.keys(value.capabilities);
    if (names.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Declare at least one capability.",
        path: ["capabilities"],
      });
    }
    for (const [name, policy] of Object.entries(value.capabilities)) {
      const unique = new Set(policy.providers);
      if (unique.size !== policy.providers.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Capability ${name} lists a provider more than once.`,
          path: ["capabilities", name, "providers"],
        });
      }
      const recommended = policy.recommendedModels ?? [];
      const seen = new Set<string>();
      for (const [index, model] of recommended.entries()) {
        if (!policy.providers.includes(model.provider)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Recommended model ${model.modelId} uses ${model.provider}, which is not allowed for ${name}.`,
            path: ["capabilities", name, "recommendedModels", index, "provider"],
          });
        }
        const key = `${model.provider}:${model.modelId}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Recommended model ${model.modelId} is listed more than once.`,
            path: ["capabilities", name, "recommendedModels", index],
          });
        }
        seen.add(key);
      }
      if (policy.defaultModel) {
        if (!policy.providers.includes(policy.defaultModel.provider)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `The default model uses ${policy.defaultModel.provider}, which is not allowed for ${name}.`,
            path: ["capabilities", name, "defaultModel", "provider"],
          });
        }
        if (
          recommended.length > 0 &&
          !recommended.some(
            (model) => model.provider === policy.defaultModel?.provider && model.modelId === policy.defaultModel?.modelId,
          )
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `The default model for ${name} must be one of recommendedModels.`,
            path: ["capabilities", name, "defaultModel"],
          });
        }
      }
    }
  });

export type AIConnectionsInput = z.input<typeof inputSchema>;

export function defineAIConnections(input: AIConnectionsInput): AIConnectionsConfig {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new AIConnectionsError("INVALID_CONFIG", message);
  }
  const capabilities: AIConnectionsConfig["capabilities"] = {};
  for (const name of CAPABILITIES) {
    const policy = parsed.data.capabilities[name];
    if (policy) {
      const recommended = policy.recommendedModels;
      const defaultModel = policy.defaultModel ?? recommended?.[0];
      capabilities[name] = {
        ...policy,
        ...(recommended ? { recommendedModels: recommended } : {}),
        ...(defaultModel ? { defaultModel } : {}),
      };
    }
  }
  return {
    appName: parsed.data.appName,
    capabilities,
    limits: parsed.data.limits,
  };
}

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
