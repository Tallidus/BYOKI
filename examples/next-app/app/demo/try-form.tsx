"use client";

import { useState } from "react";

type InvokeData = {
  outputText: string;
  provider: string;
  modelId: string;
  estimationStatus: "known" | "unknown";
  estimatedCost?: number;
  warning?: string;
};

export function TryForm({ csrfToken }: { csrfToken: string }) {
  const [capability, setCapability] = useState("chat");
  const [text, setText] = useState("Summarize what this demo just did with my key.");
  const [image, setImage] = useState("");
  const [output, setOutput] = useState<InvokeData | null>(null);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        setOutput(null);
        setRaw("");
        setPending(true);
        const input =
          capability === "vision" && image
            ? [{ role: "user", parts: [{ type: "text", text }, { type: "image", mimeType: "image/png", data: image }] }]
            : [{ role: "user", text }];
        void fetch("/api/ai/invoke", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ capability, input }),
        })
          .then(async (response) => {
            const body = (await response.json()) as { ok: boolean; data?: InvokeData; error?: { message?: string } };
            setRaw(JSON.stringify(body, null, 2));
            if (!body.ok || !body.data) setError(body.error?.message ?? "The request failed.");
            else setOutput(body.data);
          })
          .catch(() => setError("The request failed."))
          .finally(() => setPending(false));
      }}
    >
      <div>
        <label htmlFor="capability">Capability</label>
        <select id="capability" value={capability} onChange={(event) => setCapability(event.target.value)}>
          <option value="chat">chat</option>
          <option value="vision">vision</option>
        </select>
      </div>
      <div>
        <label htmlFor="prompt">Prompt</label>
        <textarea id="prompt" value={text} onChange={(event) => setText(event.target.value)} rows={4} maxLength={4000} />
      </div>
      {capability === "vision" ? (
        <div>
          <label htmlFor="image">PNG image, base64</label>
          <textarea id="image" value={image} onChange={(event) => setImage(event.target.value)} rows={3} />
        </div>
      ) : null}
      <button className="button" type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send with this session’s key"}
      </button>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {output ? (
        <div className="stack">
          {output.outputText.startsWith("mock:") ? (
            <p className="meta">Mock adapter response. The provider was not called.</p>
          ) : null}
          <p className="result">{output.outputText}</p>
          <p className="meta">
            {output.provider} · {output.modelId} ·{" "}
            {output.estimationStatus === "known" && output.estimatedCost !== undefined
              ? `$${output.estimatedCost.toFixed(4)}`
              : "Cost unavailable"}
          </p>
          {output.warning ? <p className="meta">{output.warning}</p> : null}
        </div>
      ) : null}
      {raw ? (
        <details>
          <summary>Response JSON</summary>
          <pre className="result">
            <code>{raw}</code>
          </pre>
        </details>
      ) : null}
    </form>
  );
}
