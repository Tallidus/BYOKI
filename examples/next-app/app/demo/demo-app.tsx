"use client";

import { useEffect, useState } from "react";
import { SettingsScreen } from "./settings-screen";
import { TryForm } from "./try-form";

function SessionExpiry({ expiresAt, minutesLeft }: { expiresAt: number; minutesLeft: number }) {
  const [localTime, setLocalTime] = useState<string | null>(null);
  useEffect(() => {
    setLocalTime(
      new Date(expiresAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  }, [expiresAt]);
  return (
    <>
      in about {minutesLeft} min{localTime ? `, ${localTime} your time` : ""}
    </>
  );
}

export function DemoApp({
  csrfToken,
  expiresAt,
  minutesLeft,
  mockMode,
  storeMode,
  sessionLabel,
  csrfError,
}: {
  csrfToken: string;
  expiresAt: number;
  minutesLeft: number;
  mockMode: boolean;
  storeMode: "memory" | "file";
  sessionLabel: string;
  csrfError: boolean;
}) {
  const [settingsKey, setSettingsKey] = useState(0);
  const [usageRevision, setUsageRevision] = useState(0);
  const [sampleMessage, setSampleMessage] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="stack">
      {csrfError ? (
        <p className="error" role="alert">
          The security token did not match. Reload the page and try again.
        </p>
      ) : null}
      <div className={mockMode ? "callout" : "banner"}>
        <p>
          <strong>Session {sessionLabel}.</strong> This browser has its own id. It expires{" "}
          <SessionExpiry expiresAt={expiresAt} minutesLeft={minutesLeft} />. Ending the session deletes its keys.
        </p>
        {mockMode ? (
          <p>
            Mock mode is on. Requests are answered locally and are not sent to a provider. Save any key of 8 or more
            characters, such as <code className="inline">demo-mock-key</code>. A key that starts with <code className="inline">bad</code> is rejected. Do not paste a real provider key.
          </p>
        ) : (
          <p>
            Live mode is on. A key you save is sent from this server to that provider for requests you make. It is held
            only for this session and is not written to logs. Prefer mock mode on a public site.
          </p>
        )}
        {storeMode === "file" ? (
          <p>This process is using the encrypted file store. The public demo should set BYOKI_STORE=memory.</p>
        ) : (
          <p>Keys are in process memory. They are not written to disk. A restart drops them.</p>
        )}
      </div>
      <form action="/api/session" method="post">
        <input type="hidden" name="intent" value="logout" />
        <input type="hidden" name="csrf" value={csrfToken} />
        <button className="button-secondary" type="submit">
          End session and delete keys
        </button>
      </form>
      <div className="demo-grid">
        <section className="card stack" aria-labelledby="settings-heading">
          <div>
            <p className="kicker">End-user UI</p>
            <h2 id="settings-heading">Connect a provider</h2>
            <p className="meta">This panel is <code className="inline">AIConnectionsSettings</code> from <code className="inline">@byoki/react</code>.</p>
          </div>
          {mockMode ? (
            <div className="stack">
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setSampleError(null);
                  setSampleMessage(null);
                  void fetch("/api/demo/sample", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
                  })
                    .then(async (response) => {
                      const body = (await response.json()) as { ok: boolean; error?: { message?: string } };
                      if (!body.ok) {
                        setSampleError(body.error?.message ?? "The sample connection could not be saved.");
                        return;
                      }
                      setSampleMessage("Sample OpenAI connection saved for this session. Send a prompt on the right.");
                      setSettingsKey((value) => value + 1);
                    })
                    .catch(() => setSampleError("The sample connection could not be saved."))
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? "Saving sample…" : "Load a sample mock connection"}
              </button>
              {sampleMessage ? <p className="meta">{sampleMessage}</p> : null}
              {sampleError ? (
                <p className="error" role="alert">
                  {sampleError}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="embed">
            <SettingsScreen key={settingsKey} csrfToken={csrfToken} refreshToken={usageRevision} />
          </div>
        </section>
        <div className="stack">
          <section className="card stack" aria-labelledby="try-heading">
            <div>
              <p className="kicker">Host route</p>
              <h2 id="try-heading">Send a request</h2>
              <p className="meta">
                <code className="inline">POST /api/ai/invoke</code> goes through <code className="inline">handlers.dispatch</code> for this session. The settings client never sends the prompt.
              </p>
            </div>
            <TryForm csrfToken={csrfToken} onRequested={() => setUsageRevision((value) => value + 1)} />
          </section>
          <section className="card">
            <h2>What the server did</h2>
            <ol>
              <li>Your browser posted the key to <code className="inline">PUT /api/ai/connections/:provider</code> with the session cookie and <code className="inline">x-csrf-token</code>.</li>
              <li>The handler stored it under this session’s user id. The response says connected and does not echo the key.</li>
              <li>Saving a model calls <code className="inline">PUT /api/ai/selections/:capability</code>.</li>
              <li>The prompt goes to the router, which loads the key only for the adapter call. Mock mode never opens a connection to the provider.</li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
