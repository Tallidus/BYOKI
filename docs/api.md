# API reference

The deployed docs render this reference from the package source: [https://byoki.eastonnielson.dev/docs#api](https://byoki.eastonnielson.dev/docs#api). Regenerate the JSON with `node scripts/generate-api-docs.mjs`.

On-device clients call the provider directly. That contract is [INTEGRATING.md](INTEGRATING.md). Browser code that still uses the optional host should import `@byoki/core/browser`. Server code imports `@byoki/core`, `@byoki/server`, `@byoki/providers`, and `@byoki/pricing`. `createOnDeviceClient` from `@byoki/providers` needs no server.

## Host routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/ai/connections` | Allowed providers, connection status, purposes, links, and selections. No secrets. |
| PUT | `/api/ai/connections/:provider` | Create or replace a key for the signed-in user. Body: `{ "apiKey": "..." }`. |
| DELETE | `/api/ai/connections/:provider` | Delete the stored connection for this app. |
| POST | `/api/ai/connections/:provider/test` | Test a submitted or stored key. Rate limited. A failed test returns a fixed `reason` and `category` (`invalid_key`, `rate_limited`, `quota`, `unavailable`, or `unknown`). The body does not include provider error text. |
| GET | `/api/ai/models?capability=chat` | Allowed compatible models. Add `discover=1` to refresh from the provider. |
| PUT | `/api/ai/selections/:capability` | Save an allowed provider and model. Body: `{ "provider": "openai", "modelId": "..." }`. |
| GET | `/api/ai/usage?from=...&to=...` | Observed ledger summary for the signed-in user. |
| POST | `/api/ai/invoke` | Send a chat or vision prompt. Omit `stream` for JSON. `stream: true` responds with `text/event-stream`. |

The settings client does not send prompts. Request and response shapes, bearer auth, SSE frames, and a Dart client are in [INTEGRATING.md](INTEGRATING.md).

Cookie sessions require the session cookie and an `x-csrf-token` header that matches the session. A host that has already validated `Authorization: Bearer` sets `AuthContext.transport` to `"bearer"` and does not require CSRF. Error bodies use `{ ok: false, error: { code, message } }`. Failures before the first streamed token use that JSON body. Failures after the first token are an `error` event on the stream.

Stable codes include `INVALID_CONFIG`, `PROVIDER_NOT_ALLOWED`, `CAPABILITY_UNSUPPORTED`, `MODEL_INCOMPATIBLE`, `MODEL_UNAVAILABLE`, `CREDENTIAL_MISSING`, `INVALID_KEY`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `BUDGET_BLOCKED`, `PAYLOAD_TOO_LARGE`, `UNAUTHENTICATED`, and `CSRF_FAILED`.

## Stores

`CredentialStore` is `put`, `get`, `delete`, and `has`, each scoped by `{ tenantId, userId }` and provider. `get` is for server-side calls only.

`createAIConnectionsApp` wires the router and the settings handlers. `createEncryptedFileStore` is the development implementation. It encrypts keys with AES-256-GCM and `BYOKI_MASTER_KEY`. A production host passes its own `credentials`, `selections`, and `ledger`. See `docs/deployment.md`.
