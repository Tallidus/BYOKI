export const LANDING_SNIPPET = `import { defineAIConnections } from "@byoki/core";
import { createAIConnectionsApp } from "@byoki/server";
import {
  MANUAL_CATALOG,
  PROVIDER_LINKS,
  createProviderAdapters,
} from "@byoki/providers";
import { PRICE_CATALOG, estimateCost } from "@byoki/pricing";

const ai = createAIConnectionsApp({
  config: defineAIConnections({
    appName: "Your app",
    capabilities: {
      chat: {
        description: "Answers questions for the signed-in user.",
        providers: ["openai", "anthropic", "gemini"],
        userCanChooseModel: true,
        required: true,
      },
    },
  }),
  adapters: createProviderAdapters(),
  catalog: MANUAL_CATALOG,
  links: PROVIDER_LINKS,
  estimateCost: (args) => estimateCost(PRICE_CATALOG, args),
});

// tenantId and userId come from your session. Do not take them from the browser.
await ai.router.forScope({ tenantId, userId }).invoke({
  capability: "chat",
  input: [{ role: "user", text: "Summarize this note." }],
});`;

export const SETTINGS_SNIPPET = `"use client";

import { useMemo } from "react";
import { AIConnectionsSettings, createConnectionsClient } from "@byoki/react";

export function SettingsScreen({ csrfToken }: { csrfToken: string }) {
  const client = useMemo(
    () => createConnectionsClient({ baseUrl: "/api/ai", csrfToken }),
    [csrfToken],
  );
  return <AIConnectionsSettings client={client} />;
}`;

export const NEXT_ROUTE_SNIPPET = `import { getSession } from "@/lib/auth";
import { getServices } from "@/lib/services";

async function handle(request: Request): Promise<Response> {
  const session = await getSession();
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return getServices().handlers.dispatch(request, {
    scope: session ? { tenantId: session.tenantId, userId: session.userId } : null,
    csrfHeader: request.headers.get("x-csrf-token"),
    expectedCsrf: session?.csrf ?? null,
    origin: request.headers.get("origin"),
    host,
  });
}

export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;`;

export const MOCK_SNIPPET = `import { createMockAdapter } from "@byoki/core";
import { MANUAL_CATALOG } from "@byoki/providers";

const adapters = {
  openai: createMockAdapter("openai", {
    models: MANUAL_CATALOG.filter((model) => model.provider === "openai"),
  }),
  anthropic: createMockAdapter("anthropic", {
    models: MANUAL_CATALOG.filter((model) => model.provider === "anthropic"),
  }),
  gemini: createMockAdapter("gemini", {
    models: MANUAL_CATALOG.filter((model) => model.provider === "gemini"),
  }),
};`;
