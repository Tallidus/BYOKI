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

const policySchema = z.object({
  description: z.string().min(1),
  providers: z.array(providerSchema).min(1),
  userCanChooseModel: z.boolean().default(true),
  required: z.boolean().default(false),
});

const inputSchema = z
  .object({
    appName: z.string().min(1),
    capabilities: z.record(capabilitySchema, policySchema),
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
      .default({}),
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
      capabilities[name] = policy;
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
