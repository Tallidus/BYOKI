# BYOKI

Bring-your-own-key infrastructure for app developers. Your users connect their own OpenAI, Anthropic, or Gemini keys. You keep authentication. The SDK stores keys on your server, routes by capability, and records usage.

The live demo, docs, and downloads are at [https://byoki.eastonnielson.dev](https://byoki.eastonnielson.dev).

- [Docs on the demo site](https://byoki.eastonnielson.dev/docs)
- [Live demo](https://byoki.eastonnielson.dev/demo)
- [Downloads](https://byoki.eastonnielson.dev/downloads)
- [Integration guide](docs/integration.md)
- [HTTP contract for any client, including Flutter](docs/INTEGRATING.md)
- [API reference](docs/api.md)
- [Deployment](docs/deployment.md)
- [Threat model](docs/threat-model.md)

The packages are ESM-only and require Node 20 or newer. `@byoki/react` requires React 19.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm --filter @byoki/example build
corepack pnpm test
corepack pnpm dev
```

`corepack pnpm build:site` builds the packages and the demo app. The demo app build packs tarballs and a starter zip into `examples/next-app/public/artifacts`. `corepack pnpm pack:check` packs every package again and installs those tarballs in a clean app.

## Demo site

The example in `examples/next-app` is the public product site. Each browser gets an anonymous session. There is no shared login. Keys stay in process memory by default, expire with the session, and are not logged. `BYOKI_USE_MOCK=1` (also the default when unset) answers requests locally so the server needs no provider keys.

Run it from the example directory after the build, with `PORT` set by the process manager:

```bash
corepack pnpm --filter @byoki/example start
```

### Environment

Copy `examples/next-app/.env.example` to `examples/next-app/.env.local`.

| Variable | Role |
| --- | --- |
| `SESSION_SECRET` | HMAC secret for anonymous demo session cookies. Required. |
| `BYOKI_USE_MOCK` | `1` uses mock adapters (default). `0` calls the provider with the visitor's key. |
| `BYOKI_STORE` | `memory` (default) or `file`. Use `memory` on the public site. |
| `BYOKI_MASTER_KEY` | 32-byte base64 or hex key for the development file store. Required when `BYOKI_STORE=file`. |
| `BYOKI_SESSION_TTL_SECONDS` | Session lifetime. Default `7200`. Clamped to `300`–`86400`. |
| `BYOKI_PUBLIC_HOST` | Extra hostnames allowed for proxy redirects. |
| `BYOKI_PUBLIC_ORIGIN` | Absolute site origin. Defaults to `https://byoki.eastonnielson.dev`. |
| `BYOKI_LIVE` | Set to `1` only for opt-in provider smoke tests. |
| `OPENAI_API_KEY` | Smoke tests only. The demo does not read it. |
| `ANTHROPIC_API_KEY` | Smoke tests only. The demo does not read it. |
| `GEMINI_API_KEY` | Smoke tests only. The demo does not read it. |

Behind nginx and a Cloudflare tunnel, forward `Host` and `X-Forwarded-Proto` so redirects stay on the public host. The demo ignores forwarded hosts that are not localhost, `byoki.eastonnielson.dev`, `BYOKI_PUBLIC_HOST`, or the host of `BYOKI_PUBLIC_ORIGIN`.
