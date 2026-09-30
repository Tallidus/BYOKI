import { CodeBlock } from "../../components/code-block";
import api from "../../lib/generated/api.json";
import { ERROR_CODES, HOST_ROUTES } from "../../lib/routes";
import { LANDING_SNIPPET, MOCK_SNIPPET, NEXT_ROUTE_SNIPPET, SETTINGS_SNIPPET } from "../../lib/snippets";

export const metadata = {
  title: "Docs",
  description: "Install BYOKI, configure the demo, and read the API generated from the package source.",
};

const NAV = [
  ["#install", "Installation"],
  ["#quick-start", "Quick start"],
  ["#configuration", "Configuration"],
  ["#api", "API reference"],
  ["#security", "Security model"],
  ["#production", "Production"],
  ["#frameworks", "Frameworks"],
];

export default function DocsPage() {
  return (
    <main className="wrap docs-layout">
      <nav className="docs-nav" aria-label="Documentation">
        {NAV.map(([href, label]) => (
          <a key={href} href={href}>
            {label}
          </a>
        ))}
      </nav>
      <article className="docs-prose">
        <p className="kicker">Documentation</p>
        <h1>Install BYOKI and wire it to your session.</h1>
        <p className="lede">
          The API section on this page is generated from the package exports when the site is built. The narrative around it matches the example app in this repository.
        </p>

        <section id="install">
          <h2>Installation</h2>
          <p>The packages are ESM-only, versioned together, and licensed under MIT. They need Node 20 or newer. <code className="inline">@byoki/react</code> needs React 19. There is no CommonJS build.</p>
          <p>After the packages are published:</p>
          <CodeBlock code={api.install.pnpm} label="pnpm" />
          <CodeBlock code={api.install.npm} label="npm" />
          <p>
            Until then, download the tarballs from the <a href="/downloads">downloads page</a>. Those files are produced by <code className="inline">pnpm pack</code> during the demo app build.
          </p>
          <p>Inside this repository:</p>
          <CodeBlock
            code={`corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm --filter @byoki/example build
corepack pnpm --filter @byoki/example dev`}
            label="repository"
          />
        </section>

        <section id="quick-start">
          <h2>Quick start</h2>
          <p>Resolve the signed-in user in your own auth middleware. Pass that <code className="inline">{`{ tenantId, userId }`}</code> into the router. Do not accept a user id from the browser as authorization.</p>
          <CodeBlock code={LANDING_SNIPPET} label="server.ts" />
          <p>A capability controls SDK routing and the settings screen. It does not limit what the provider account can do with that key. The host that stores the key can also use it outside this SDK.</p>
          <h3>Mock adapters</h3>
          <p>Set <code className="inline">BYOKI_USE_MOCK=1</code> and pass mock adapters when you want the same routing without a paid call. The public demo does this by default.</p>
          <CodeBlock code={MOCK_SNIPPET} label="mock adapters" />
          <h3>Settings UI</h3>
          <CodeBlock code={SETTINGS_SNIPPET} label="settings-screen.tsx" />
          <p>Pass <code className="inline">csrfToken</code> from the server session. Mutating requests send it as <code className="inline">x-csrf-token</code>.</p>
        </section>

        <section id="configuration">
          <h2>Configuration</h2>
          <p>Put secrets in the host environment, not in the image and not in git. The demo app reads <code className="inline">examples/next-app/.env.local</code> in local development. Copy <code className="inline">.env.example</code> and fill it in.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Required</th>
                  <th>Used by</th>
                  <th>Purpose</th>
                </tr>
              </thead>
              <tbody>
                {api.env.map((item) => (
                  <tr key={item.name}>
                    <td>
                      <code>{item.name}</code>
                    </td>
                    <td>{item.required}</td>
                    <td>{item.usedBy}</td>
                    <td>{item.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Generate a master key</h3>
          <CodeBlock
            code={`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`}
            label="shell"
          />
          <p>
            <code className="inline">defineAIConnections</code> checks the config with zod. It requires an app name and at least one capability. Providers are <code className="inline">openai</code>, <code className="inline">anthropic</code>, and <code className="inline">gemini</code>. Capabilities in this version are <code className="inline">chat</code> and <code className="inline">vision</code>.
          </p>
        </section>

        <section id="api">
          <h2>API reference</h2>
          <p>Browser code imports <code className="inline">@byoki/core/browser</code>. Server code imports the other entry points. Signatures below are taken from the TypeScript source of each public export.</p>
          <h3>Host routes</h3>
          <p>Forward <code className="inline">/api/ai/*</code> to <code className="inline">handlers.dispatch</code> with the session scope. The example also exposes <code className="inline">POST /api/ai/invoke</code>, which is a host route, not part of the settings client.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Purpose</th>
                </tr>
              </thead>
              <tbody>
                {HOST_ROUTES.map((route) => (
                  <tr key={`${route.method} ${route.path}`}>
                    <td>{route.method}</td>
                    <td>
                      <code>{route.path}</code>
                    </td>
                    <td>{route.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>Mutating routes need the session cookie and a matching CSRF token. Error bodies use <code className="inline">{`{ ok: false, error: { code, message } }`}</code>.</p>
          <p>
            Stable codes:{" "}
            {ERROR_CODES.map((code, index) => (
              <span key={code}>
                {index > 0 ? " " : null}
                <code className="inline">{code}</code>
              </span>
            ))}
            .
          </p>
          {api.packages.map((pkg) => (
            <section key={pkg.name} id={pkg.name.replace("@", "").replace("/", "-")}>
              <h3>
                <code>{pkg.name}</code>
              </h3>
              <p>
                {pkg.description} Version {pkg.version}. Node {pkg.engines}.
              </p>
              {pkg.entries.map((entry) => (
                <div key={entry.importFrom}>
                  <p className="entry-label">
                    Import from <code className="inline">{entry.importFrom}</code>
                  </p>
                  {entry.symbols.map((symbol) => (
                    <details key={`${entry.importFrom}-${symbol.name}`} className="symbol">
                      <summary>
                        <code>{symbol.name}</code>
                        <span className="badge">{symbol.kind}</span>
                      </summary>
                      {symbol.docs ? <p>{symbol.docs}</p> : null}
                      <pre>
                        <code>{symbol.signature}</code>
                      </pre>
                    </details>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </section>

        <section id="security">
          <h2>Security model</h2>
          <p>The host authenticates the user and then holds that user’s provider key. Anything running on that server can use the key outside this SDK. Users should also set spending limits in the provider account. A declared capability restricts SDK routing and the settings UI. It does not restrict the provider account.</p>
          <h3>What the SDK enforces</h3>
          <ul>
            <li>Keys are submitted over the host session. The reference UI does not write them to browser storage.</li>
            <li>Read endpoints return connection status, not the key.</li>
            <li>The development file store encrypts keys with AES-256-GCM. The master key comes from the environment.</li>
            <li>Logs pass through a redactor that strips common key prefixes and fields named like secrets.</li>
            <li>Records are scoped by tenant and user.</li>
            <li>Provider calls use fixed HTTPS endpoints. This release does not accept a caller-supplied provider URL.</li>
            <li>Connection tests and model discovery are rate limited.</li>
            <li>Upstream error text is truncated and stripped of key-shaped strings before it is shown.</li>
          </ul>
          <h3>What this public demo adds</h3>
          <ul>
            <li>Each visitor gets an anonymous session id. There is no shared password.</li>
            <li>The default store is process memory. Keys are deleted when the session expires, the visitor ends the session, or the process restarts.</li>
            <li>Mock mode is the default, including when <code className="inline">BYOKI_USE_MOCK</code> is unset, so the site can run with no provider credentials on the server.</li>
            <li>Redirects only honor <code className="inline">byoki.eastonnielson.dev</code>, localhost, and hosts you list in <code className="inline">BYOKI_PUBLIC_HOST</code> or <code className="inline">BYOKI_PUBLIC_ORIGIN</code>. A stray forwarded host cannot send the browser elsewhere.</li>
            <li>The invoke route redacts error text and does not log the prompt or the key.</li>
          </ul>
          <p>Local deletion removes the key from this app. It does not revoke the key at the provider. Budget checks are best-effort and are not a guaranteed spending cap.</p>
        </section>

        <section id="production">
          <h2>Production guidance</h2>
          <p>Implement <code className="inline">CredentialStore</code> with a secrets manager or envelope encryption whose data keys live outside the app. The type <code className="inline">ProductionCredentialStore</code> marks that implementation. Pass <code className="inline">credentials</code>, <code className="inline">selections</code>, and <code className="inline">ledger</code> into <code className="inline">createAIConnectionsApp</code>. <code className="inline">assertProductionStore</code> checks the <code className="inline">kind</code> field.</p>
          <p>Do not ship the development file store, and do not use this demo’s anonymous sessions, as production auth. Scope every secret by the tenant and user your auth system resolved. Keep plaintext keys in memory only for the provider call that needs them.</p>
          <p>Serve the host over HTTPS. Keep the master key or the secrets-manager credentials in the platform secret store. Avoid screenshots, traces, and analytics that include the key field.</p>
          <p>A model without a reviewed price entry shows “Cost unavailable”, not zero. Real provider streaming is not part of 0.1. The mock adapter can record a streamed ledger row so the shape is covered.</p>
        </section>

        <section id="frameworks">
          <h2>Framework integration</h2>
          <h3>Next.js App Router</h3>
          <p>The demo app mounts the handlers on a catch-all route. Compare <code className="inline">origin</code> to the public host when you are behind nginx or a Cloudflare tunnel, not to the internal bind address.</p>
          <CodeBlock code={NEXT_ROUTE_SNIPPET} label="app/api/ai/[[...path]]/route.ts" />
          <p>Call <code className="inline">router.forScope</code> from your own feature route, the way <code className="inline">POST /api/ai/invoke</code> does. Set the cookie <code className="inline">Secure</code> flag from <code className="inline">X-Forwarded-Proto</code> when TLS terminates at the proxy.</p>
          <h3>Node HTTP</h3>
          <p>
            The starter zip on the downloads page is a <code className="inline">node:http</code> server that binds to <code className="inline">127.0.0.1:8787</code> and forwards <code className="inline">/api/ai/*</code> to <code className="inline">handlers.dispatch</code>. It uses the development file store so you can see <code className="inline">BYOKI_MASTER_KEY</code>. Replace its fixed local user before you expose it.
          </p>
          <p>Any framework that can build a Fetch <code className="inline">Request</code> can call <code className="inline">handlers.dispatch</code>. The handler does not depend on Next.js.</p>
        </section>
      </article>
    </main>
  );
}
