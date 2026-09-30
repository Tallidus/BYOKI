import { CodeBlock } from "../components/code-block";
import api from "../lib/generated/api.json";
import { LANDING_SNIPPET, SETTINGS_SNIPPET } from "../lib/snippets";

export default function HomePage() {
  return (
    <main className="wrap">
      <p className="kicker">Bring your own key integration</p>
      <h1>Add bring-your-own API keys to your app.</h1>
      <p className="lede">
        BYOKI is a TypeScript SDK for developers. Your users connect their own OpenAI, Anthropic, or Gemini key. You
        keep authentication. The SDK stores the key on your server, routes each feature to the model they picked, and
        records usage without keeping the prompt.
      </p>
      <div className="button-row">
        <a className="button" href="/demo">
          Open the live demo
        </a>
        <a className="button-secondary" href="/docs">
          Read the docs
        </a>
        <a className="button-secondary" href="/downloads">
          Download packages
        </a>
      </div>

      <section className="section" id="who">
        <h2>Who it is for</h2>
        <div className="grid-3">
          <article className="card">
            <h3>App developers</h3>
            <p>You already have accounts and a product. You want each customer to bring a model-provider key into that product.</p>
          </article>
          <article className="card">
            <h3>Your auth stays yours</h3>
            <p>BYOKI does not sign users in. You pass a tenant id and user id from the session your app already trusts.</p>
          </article>
          <article className="card">
            <h3>A settings screen included</h3>
            <p>
              <code className="inline">@byoki/react</code> renders the key form, model picker, and usage table. The browser package does not store the key.
            </p>
          </article>
        </div>
      </section>

      <section className="section" id="how-it-works">
        <h2>How a key moves</h2>
        <p className="lede">Four steps, all on your server after the browser submits the key.</p>
        <div className="flow">
          <article className="step">
            <span>1 · Capture</span>
            <h3>The browser posts the key</h3>
            <p>The reference UI uses a password field and sends the key to your host with the session cookie and a CSRF token. It does not write the key to localStorage or sessionStorage.</p>
          </article>
          <article className="step">
            <span>2 · Encrypt</span>
            <h3>The server seals it</h3>
            <p>Production storage is yours: a secrets manager or envelope encryption. The development file store uses AES-256-GCM and <code className="inline">BYOKI_MASTER_KEY</code>, which never sits in the data file.</p>
          </article>
          <article className="step">
            <span>3 · Scope</span>
            <h3>One user, one record</h3>
            <p>Rows are stored under the tenant and user your auth resolved. Read APIs return “connected”. They do not return the key. Another user cannot list, replace, or delete it.</p>
          </article>
          <article className="step">
            <span>4 · Call</span>
            <h3>Use it, then forget the prompt</h3>
            <p>The router loads the key only for that provider call, then writes a usage row with tokens, latency, and estimated cost. The ledger does not store the prompt, the response, or the key.</p>
          </article>
        </div>
      </section>

      <section className="section" id="integrate">
        <h2>Integration is a config object and one call</h2>
        <p>Declare the capabilities your product offers, then invoke through the signed-in user. The packages are ESM-only and need Node 20 or newer. <code className="inline">@byoki/react</code> needs React 19.</p>
        <CodeBlock code={LANDING_SNIPPET} label="server.ts" />
        <p>Mount the settings screen in a client component and pass the CSRF token from your session.</p>
        <CodeBlock code={SETTINGS_SNIPPET} label="settings-screen.tsx" />
      </section>

      <section className="section" id="demo-safety">
        <h2>This site is safe to click through</h2>
        <div className="callout">
          <p>
            <strong>No shared accounts.</strong> The live demo gives each browser its own anonymous session. There is no alice/alice login that lets a stranger open someone else’s keys.
          </p>
          <p>
            <strong>Mock mode is the default.</strong> With <code className="inline">BYOKI_USE_MOCK=1</code>, or when that variable is unset, requests stay inside the mock adapter. The server does not need a provider key, and a key typed into the demo is not sent to OpenAI, Anthropic, or Gemini.
          </p>
          <p>
            <strong>Short memory.</strong> The default store keeps keys in the Node process for two hours, then drops them. Ending the session deletes them immediately. They are not written to disk and request logs do not include them.
          </p>
        </div>
      </section>

      <section className="section" id="packages">
        <h2>Packages</h2>
        <div className="package-grid">
          {api.packages.map((pkg) => (
            <article key={pkg.name} className="package-card">
              <h3>
                <code>{pkg.name}</code>
              </h3>
              <p>{pkg.description}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
