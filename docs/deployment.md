# Deployment

## Public demo

The site at [https://byoki.eastonnielson.dev](https://byoki.eastonnielson.dev) is `examples/next-app`. On the Ubuntu host (Node 20):

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm --filter @byoki/example build
```

Run `next start` from `examples/next-app` (or `corepack pnpm --filter @byoki/example start`) with `PORT=3004`. Put the variables from `examples/next-app/.env.example` in the process environment. For the public site use:

```
SESSION_SECRET=<long random string>
BYOKI_USE_MOCK=1
BYOKI_STORE=memory
BYOKI_PUBLIC_ORIGIN=https://byoki.eastonnielson.dev
```

`BYOKI_MASTER_KEY` is not required while `BYOKI_STORE=memory`. Nginx and the Cloudflare tunnel should pass the public `Host` and `X-Forwarded-Proto: https`. Redirects are built from those headers only when the host is allowed, so a bad forwarded host cannot send browsers to localhost or another site. The session cookie is `Secure` when the forwarded protocol is HTTPS.

The example build writes package tarballs and `byoki-starter.zip` into `examples/next-app/public/artifacts`. `next start` serves them from `/artifacts/`.

## Development

Generate secrets and put them in `examples/next-app/.env.local`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```
BYOKI_MASTER_KEY=<32-byte base64 or hex key>
SESSION_SECRET=<long random string>
BYOKI_USE_MOCK=1
BYOKI_STORE=memory
BYOKI_SESSION_TTL_SECONDS=7200
```

`BYOKI_MASTER_KEY` encrypts the development credential file when `BYOKI_STORE=file` (or when `createAIConnectionsApp` is called without your own stores). Losing the key makes stored credentials unreadable. Do not commit the key, the data file, or `.env.local`. The public demo defaults to `BYOKI_STORE=memory` and does not write keys to disk.

`BYOKI_USE_MOCK=1` uses the mock adapters. That is also the demo default when the variable is unset. Set `BYOKI_USE_MOCK=0` when you want the example to call OpenAI, Anthropic, and Gemini with user-supplied keys.

## Production store

Implement `CredentialStore` from `@byoki/core` with a secrets manager or envelope encryption whose data keys are managed outside the app. The type `ProductionCredentialStore` marks that implementation. Pass `credentials`, `selections`, and `ledger` into `createAIConnectionsApp`. Do not ship the development file store as production storage.

Scope every secret by the tenant and user your auth system resolved. Keep plaintext keys in memory only for the provider call that needs them.

Serve the host over HTTPS. Keep the master key or secrets-manager credentials in the platform secret store, not in the image.

## Release check

From the repository root:

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm test
corepack pnpm pack:check
```

`pack:check` builds each package tarball, rejects secrets and `workspace:` dependency specifiers, then installs the tarballs in a clean app and imports `@byoki/core`.

## Publishing

The packages are versioned together at `0.1.0` and are licensed under MIT.

`.github/workflows/publish.yml` publishes `packages/*` when a GitHub release is published. It installs with `--frozen-lockfile`. `pnpm publish` rewrites `workspace:*` dependencies, then calls `npm publish`. The job requests `id-token: write` and does not use a long-lived npm token. npm trusted publishing exchanges the GitHub Actions OIDC token for a short-lived credential and, for this public repository, attaches a provenance attestation (`--provenance`).

Each published package needs a trusted publisher on npmjs.com before that workflow can succeed. For `@byoki/core`, `@byoki/pricing`, `@byoki/providers`, `@byoki/react`, and `@byoki/server`, open the package settings (or the account trusted-publisher setup, if the package has never been published) and add GitHub Actions:

- Organization or user: `Tallidus`
- Repository: `BYOKI`
- Workflow filename: `publish.yml` (the filename only, not the `.github/workflows/` path)
- Allow direct `npm publish`. Configurations created after 3 September 2026 start as staged publishing only, which this workflow does not use.

After one release publishes through that trusted publisher, delete the `NPM_TOKEN` Actions secret. Token publishing is no longer used. For a stricter setting, each package can require two-factor authentication and disallow tokens; trusted publishers keep working.

`corepack pnpm publish:packages` is the local equivalent. It still needs an npm login on that machine and is not part of CI.
