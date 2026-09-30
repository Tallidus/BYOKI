# BYOKI

Bring-your-own-key AI connections for a host application. The host owns authentication and production secret storage. This SDK routes by declared capability, stores provider keys on the server, and shows observed usage.

The packages are ESM-only and require Node 20 or newer. `@byoki/react` requires React 19.

- [Integration guide](docs/integration.md)
- [API reference](docs/api.md)
- [Deployment and publishing](docs/deployment.md)
- [Threat model](docs/threat-model.md)

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm test
corepack pnpm dev
```

The example signs in Alice (`alice`) or Bob (`bob`) and expects `examples/next-app/.env.local` as described in the deployment guide. `corepack pnpm pack:check` packs every package and installs those tarballs in a clean app.
