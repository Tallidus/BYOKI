# BYOKI starter

Local integration kit for Node 20 or newer. It listens on `127.0.0.1:8787` only. The signed-in user is the fixed local user `local-dev`. Replace that with your own session before you expose a port.

This zip includes the packed `@byoki/core`, `@byoki/server`, `@byoki/providers`, and `@byoki/pricing` tarballs in `vendor/`. `@byoki/react` is on the downloads page for the settings screen and is not required to run this server.

## Run

```bash
cp .env.example .env
# Put a 32-byte base64 or hex key in BYOKI_MASTER_KEY.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
corepack pnpm install
corepack pnpm start
```

`BYOKI_USE_MOCK=1` uses the mock adapters. The process still needs `BYOKI_MASTER_KEY` because `createAIConnectionsApp` stores credentials in the encrypted development file at `.data/byoki-store.json`.

`GET /health` reports whether mock mode is on.

Save a key and ask a question:

```bash
curl -s -X PUT http://127.0.0.1:8787/api/ai/connections/openai \
  -H 'content-type: application/json' \
  -H 'x-csrf-token: local-dev' \
  -d '{"apiKey":"demo-mock-key"}'

curl -s -X PUT http://127.0.0.1:8787/api/ai/selections/chat \
  -H 'content-type: application/json' \
  -H 'x-csrf-token: local-dev' \
  -d '{"provider":"openai","modelId":"gpt-5.6-terra"}'
```

Calling the model is the host's route. See the Next.js example in the BYOKI docs. This kit shows the settings handlers and the development store.

## Production

Pass your own `credentials`, `selections`, and `ledger` into `createAIConnectionsApp`. Do not ship the development file store. The public demo site uses an in-memory store with a short session lifetime instead of this file, because that site is open to anonymous visitors.
