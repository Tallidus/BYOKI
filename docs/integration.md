# Integration guide

BYOKI is an ESM package set for Node 20 or newer. `@byoki/react` requires React 19. There is no CommonJS build. Real provider streaming is not part of 0.1. A model without a reviewed price entry shows “Cost unavailable,” not zero.

Install the packages in a TypeScript host that already authenticates users:

```bash
corepack pnpm add @byoki/core @byoki/server @byoki/providers @byoki/pricing @byoki/react
```

That command works after the packages are published. Inside this repository, run `corepack pnpm install --frozen-lockfile`, `corepack pnpm build`, then `corepack pnpm --filter @byoki/example dev`. The public demo, generated API docs, and packed downloads are served from the example app at [https://byoki.eastonnielson.dev](https://byoki.eastonnielson.dev).

## Declare capabilities and start the server SDK

Resolve the signed-in user in your own auth middleware. Pass that trusted `{ tenantId, userId }` into the router. Do not accept a user id from the browser as authorization.

Development can omit custom stores. `createAIConnectionsApp` then encrypts keys with `BYOKI_MASTER_KEY`. Production passes its own `credentials`, `selections`, and `ledger` implementations and does not use the file store.

```ts
import { defineAIConnections } from "@byoki/core";
import { estimateCost, PRICE_CATALOG } from "@byoki/pricing";
import { MANUAL_CATALOG, PROVIDER_LINKS, createProviderAdapters } from "@byoki/providers";
import { createAIConnectionsApp } from "@byoki/server";

const config = defineAIConnections({
  appName: "Your app",
  capabilities: {
    chat: {
      description: "Answers questions about vehicle repairs.",
      providers: ["openai", "anthropic", "gemini"],
      userCanChooseModel: true,
      required: true,
    },
    vision: {
      description: "Analyzes photos you submit.",
      providers: ["openai", "gemini"],
      userCanChooseModel: true,
      required: false,
    },
  },
});

export const ai = createAIConnectionsApp({
  config,
  adapters: createProviderAdapters(),
  catalog: MANUAL_CATALOG,
  links: PROVIDER_LINKS,
  estimateCost: (args) => estimateCost(PRICE_CATALOG, args),
});

// After your auth middleware has resolved the user:
const result = await ai.router.forScope({ tenantId, userId }).invoke({
  capability: "chat",
  input: [{ role: "user", text: "Explain this dashboard warning." }],
});
```

A capability controls SDK routing and the settings screen. It does not limit what a provider API key can do. The host server that stores the key can also use that key outside this SDK. Use a secrets manager for production. See [deployment.md](deployment.md).

## Host routes

Forward `/api/ai/*` to `ai.handlers.dispatch` with the session scope and CSRF token. The example does this in `examples/next-app/app/api/ai/[[...path]]/route.ts`. A separate host route, such as `POST /api/ai/invoke`, calls `ai.router`. The settings client does not send prompts.

Mutating requests need the session cookie and an `x-csrf-token` header that matches the session.

## Settings UI

In a client component:

```tsx
"use client";

import { useMemo } from "react";
import { AIConnectionsSettings, createConnectionsClient } from "@byoki/react";

export function SettingsScreen({ csrfToken }: { csrfToken: string }) {
  const client = useMemo(
    () => createConnectionsClient({ baseUrl: "/api/ai", csrfToken }),
    [csrfToken],
  );
  return <AIConnectionsSettings client={client} />;
}
```

Pass `csrfToken` from the server session. The browser package does not store keys.

## What 0.1 does not include

- CommonJS entry points or a React 18 build.
- Streaming from OpenAI, Anthropic, or Gemini. The mock adapter can record a streamed ledger row so the shape is covered.
- Prices for every catalog model. Missing prices stay unknown.
- A hosted multi-tenant service, Ollama, embeddings, image generation, or speech.

Set `BYOKI_USE_MOCK=1` in the example to avoid paid API calls. Live smoke tests stay out of CI. Run them with `BYOKI_LIVE=1` and `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY`.
