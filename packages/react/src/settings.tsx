"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ProviderId } from "@byoki/core/browser";
import type { ConnectionsClient, ConnectionsView, ModelView, UsageView } from "./client.js";

const NAMES: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};

function money(value: number | null, status: "known" | "unknown"): string {
  if (status === "unknown" || value === null) return "Cost unavailable";
  return `$${value.toFixed(4)}`;
}

export function AIConnectionsSettings({
  client,
  refreshToken = 0,
}: {
  client: ConnectionsClient;
  /** Increment after a host request so usage reloads without resetting the form. */
  refreshToken?: number;
}) {
  const [view, setView] = useState<ConnectionsView | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const statusId = useId();
  const requestId = useRef(0);
  const loaded = useRef(false);

  async function reload() {
    const id = ++requestId.current;
    if (!loaded.current) setLoading(true);
    setError(null);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const [connections, usageView] = await Promise.all([
        client.getConnections(),
        client.getUsage(from.toISOString(), to.toISOString()),
      ]);
      if (id !== requestId.current) return;
      setView(connections);
      setUsage(usageView);
      loaded.current = true;
    } catch (caught) {
      if (id !== requestId.current) return;
      setError(caught instanceof Error ? caught.message : "The settings could not be loaded.");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [client, refreshToken]);

  return (
    <div className="byoki">
      <style>{STYLES}</style>
      <header className="byoki-header">
        <p className="byoki-kicker">AI connections</p>
        <h1>{view?.appName ?? "Connections"}</h1>
      </header>
      <div id={statusId} role="status" aria-live="polite">
        {loading ? <p>Loading connections…</p> : null}
        {error ? <p className="byoki-error">{error}</p> : null}
      </div>
      {view ? (
        <>
          <PurposeSection view={view} client={client} onChange={reload} statusId={statusId} />
          <ModelSection view={view} client={client} onChange={reload} />
          <UsageSection view={view} usage={usage} />
          <ControlsSection view={view} />
        </>
      ) : null}
    </div>
  );
}

function PurposeSection({
  view,
  client,
  onChange,
  statusId,
}: {
  view: ConnectionsView;
  client: ConnectionsClient;
  onChange: () => Promise<void>;
  statusId: string;
}) {
  return (
    <section aria-labelledby="byoki-purpose">
      <h2 id="byoki-purpose">Purpose and connections</h2>
      <p>{view.notices.capabilityDoesNotLimitKey}</p>
      <p>{view.notices.hostOperatesKey}</p>
      <ul className="byoki-purposes">
        {view.capabilities.map((capability) => (
          <li key={capability.id}>
            <strong>{capability.id}</strong>
            {capability.required ? " (required)" : " (optional)"}: {capability.description}
          </li>
        ))}
      </ul>
      <div className="byoki-grid">
        {view.providers.map((provider) => (
          <ConnectionCard
            key={provider.id}
            provider={provider}
            client={client}
            deletionNote={view.notices.localDeletionDoesNotRevoke}
            quotaNote={view.notices.testMaySpendQuota}
            onChange={onChange}
            statusId={statusId}
          />
        ))}
      </div>
    </section>
  );
}

function ConnectionCard({
  provider,
  client,
  deletionNote,
  quotaNote,
  onChange,
  statusId,
}: {
  provider: ConnectionsView["providers"][number];
  client: ConnectionsClient;
  deletionNote: string;
  quotaNote: string;
  onChange: () => Promise<void>;
  statusId: string;
}) {
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const name = NAMES[provider.id];

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "That action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="byoki-card" aria-labelledby={`${inputId}-title`}>
      <h3 id={`${inputId}-title`}>{name}</h3>
      <p>
        Status: <span className="byoki-status">{provider.status === "connected" ? "Connected" : "Not connected"}</span>
      </p>
      <p>
        <a href={provider.keyUrl}>Get a {name} key</a>
      </p>
      <label htmlFor={inputId}>API key</label>
      <input
        id={inputId}
        type="password"
        autoComplete="off"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        aria-describedby={statusId}
      />
      <div className="byoki-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (provider.testMaySpendQuota && !window.confirm(quotaNote)) return;
              const result = await client.testKey(provider.id, apiKey || undefined);
              setMessage(result.ok ? "The key was accepted." : result.reason ?? "The key was rejected.");
            })
          }
        >
          Test
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await client.putKey(provider.id, apiKey);
              setApiKey("");
              setMessage(provider.status === "connected" ? "The key was replaced." : "The key was saved.");
              await onChange();
            })
          }
        >
          {provider.status === "connected" ? "Replace" : "Save"}
        </button>
        <button
          type="button"
          disabled={busy || provider.status !== "connected"}
          onClick={() =>
            run(async () => {
              await client.deleteKey(provider.id);
              setMessage(deletionNote);
              await onChange();
            })
          }
        >
          Remove
        </button>
      </div>
      {message ? <p>{message}</p> : null}
      <p className="byoki-note">{deletionNote}</p>
    </article>
  );
}

function ModelSection({
  view,
  client,
  onChange,
}: {
  view: ConnectionsView;
  client: ConnectionsClient;
  onChange: () => Promise<void>;
}) {
  return (
    <section aria-labelledby="byoki-models">
      <h2 id="byoki-models">Model choices</h2>
      {view.capabilities.map((capability) => (
        <ModelPicker key={capability.id} capability={capability} client={client} onChange={onChange} />
      ))}
    </section>
  );
}

function ModelPicker({
  capability,
  client,
  onChange,
}: {
  capability: ConnectionsView["capabilities"][number];
  client: ConnectionsClient;
  onChange: () => Promise<void>;
}) {
  const [models, setModels] = useState<ModelView[]>([]);
  const [choice, setChoice] = useState(
    capability.selection ? `${capability.selection.provider}:${capability.selection.modelId}` : "",
  );
  const [message, setMessage] = useState<string | null>(capability.selectionIssue?.message ?? null);
  const selectId = useId();

  useEffect(() => {
    void client.getModels(capability.id).then((result) => setModels(result.models)).catch((caught: unknown) => {
      setMessage(caught instanceof Error ? caught.message : "Models could not be loaded.");
    });
  }, [capability.id, client]);

  if (!capability.userCanChooseModel) {
    return <p>{capability.id} uses a model chosen by the app.</p>;
  }

  return (
    <form
      className="byoki-card"
      onSubmit={(event) => {
        event.preventDefault();
        const [provider, modelId] = choice.split(":");
        if (!provider || !modelId) return;
        void client
          .putSelection(capability.id, provider as ProviderId, modelId)
          .then(() => onChange())
          .catch((caught: unknown) => setMessage(caught instanceof Error ? caught.message : "The selection was rejected."));
      }}
    >
      <label htmlFor={selectId}>Model for {capability.id}</label>
      <select id={selectId} value={choice} onChange={(event) => setChoice(event.target.value)}>
        <option value="">Choose a connected model</option>
        {models.map((model) => (
          <option key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>
            {NAMES[model.provider]} · {model.displayName}
          </option>
        ))}
      </select>
      <p className="byoki-note">
        Catalog checked {models[0]?.catalogUpdatedAt ?? "when this list was published"}. A listed model may be disabled on your account.
      </p>
      {message ? <p className="byoki-error">{message}</p> : null}
      <button type="submit">Save model</button>
    </form>
  );
}

function UsageSection({ view, usage }: { view: ConnectionsView; usage: UsageView | null }) {
  return (
    <section aria-labelledby="byoki-usage">
      <h2 id="byoki-usage">Usage</h2>
      {usage ? (
        <>
          <p>{usage.label}</p>
          <p>
            {usage.requests} requests ({usage.successes} succeeded, {usage.failures} failed). Estimated cost:{" "}
            {money(usage.estimatedCost, usage.estimationStatus)}
          </p>
          <ul>
            {view.providers.map((provider) => (
              <li key={provider.id}>
                <a href={provider.usageUrl}>{NAMES[provider.id]} usage</a>
                {" · "}
                <a href={provider.billingUrl}>billing</a>
              </li>
            ))}
          </ul>
          {usage.units.length === 0 ? <p>No requests in this period.</p> : null}
          <table>
            <caption className="byoki-note">Requests observed in this app</caption>
            <thead>
              <tr>
                <th>Time</th>
                <th>Capability</th>
                <th>Model</th>
                <th>Outcome</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.units.map((row) => (
                <tr key={`${row.time}-${row.modelId}-${row.outcome}`}>
                  <td>{row.time}</td>
                  <td>{row.capability}</td>
                  <td>{row.modelId}</td>
                  <td>{row.outcome}</td>
                  <td>{money(row.estimatedCost, row.estimationStatus)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p>Usage has not loaded.</p>
      )}
    </section>
  );
}

function ControlsSection({ view }: { view: ConnectionsView }) {
  const budget = view.limits.budget;
  const warn =
    budget?.warnAtUsd !== undefined && view.observedSpendUsd >= budget.warnAtUsd
      ? "Observed spend in this app reached the warning threshold."
      : null;
  return (
    <section aria-labelledby="byoki-controls">
      <h2 id="byoki-controls">Controls</h2>
      <p>{view.notices.budgetIsBestEffort}</p>
      <ul>
        <li>Request timeout: {view.limits.requestTimeoutMs} ms</li>
        <li>Output token cap: {view.limits.maxOutputTokens ?? "Not set"}</li>
        <li>Warning threshold: {budget?.warnAtUsd !== undefined ? `$${budget.warnAtUsd}` : "Not set"}</li>
        <li>Best-effort block threshold: {budget?.blockAtUsd !== undefined ? `$${budget.blockAtUsd}` : "Not set"}</li>
        <li>
          Observed known spend this month: ${view.observedSpendUsd.toFixed(4)}
          {view.observedSpendHasUnknown ? " (some calls have unknown cost and are excluded)" : ""}
        </li>
      </ul>
      {warn ? <p role="alert">{warn}</p> : null}
    </section>
  );
}

const STYLES = `
.byoki { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1915; max-width: 960px; }
.byoki-kicker { letter-spacing: 0.08em; text-transform: uppercase; color: #8a5a2a; font-size: 0.75rem; margin: 0; }
.byoki h1 { font-family: inherit; font-weight: 700; font-size: clamp(1.5rem, 3vw, 2rem); letter-spacing: -0.03em; line-height: 1.15; margin: 0.2rem 0 1rem; }
.byoki h2 { font-size: 1.15rem; margin-top: 2rem; }
.byoki-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
.byoki-card, .byoki section { }
.byoki-card { border: 1px solid #e4d7c8; background: #fffaf3; padding: 1rem; border-radius: 12px; margin-bottom: 1rem; }
.byoki label { display: block; font-weight: 600; margin-top: 0.75rem; }
.byoki input, .byoki select, .byoki button { font: inherit; }
.byoki input, .byoki select { width: 100%; box-sizing: border-box; padding: 0.45rem 0.55rem; border: 1px solid #c8b8a4; border-radius: 8px; background: white; }
.byoki-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
.byoki button { background: #8a5a2a; color: white; border: 0; border-radius: 999px; padding: 0.4rem 0.85rem; cursor: pointer; }
.byoki button:disabled { opacity: 0.5; cursor: not-allowed; }
.byoki button:focus-visible, .byoki input:focus-visible, .byoki select:focus-visible, .byoki a:focus-visible { outline: 2px solid #1c1915; outline-offset: 2px; }
.byoki-status { font-weight: 700; }
.byoki-note { color: #5c5348; font-size: 0.9rem; }
.byoki-error { color: #8d1d1d; }
.byoki table { width: 100%; border-collapse: collapse; }
.byoki th, .byoki td { text-align: left; border-bottom: 1px solid #e4d7c8; padding: 0.35rem; font-size: 0.9rem; }
@media (max-width: 640px) {
  .byoki-actions { flex-direction: column; }
  .byoki button { width: 100%; }
}
`;
