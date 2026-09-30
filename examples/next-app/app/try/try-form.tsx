"use client";

import { useState } from "react";

export function TryForm({ csrfToken }: { csrfToken: string }) {
  const [capability, setCapability] = useState("chat");
  const [text, setText] = useState("Explain this dashboard warning.");
  const [image, setImage] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");

  return (
    <form
      className="login"
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        setOutput("");
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
            const body = await response.json();
            if (!body.ok) setError(body.error?.message ?? "The request failed.");
            else setOutput(body.data.outputText);
          })
          .catch(() => setError("The request failed."));
      }}
    >
      <label htmlFor="capability">Capability</label>
      <select id="capability" value={capability} onChange={(event) => setCapability(event.target.value)}>
        <option value="chat">chat</option>
        <option value="vision">vision</option>
      </select>
      <label htmlFor="prompt">Prompt</label>
      <textarea id="prompt" value={text} onChange={(event) => setText(event.target.value)} rows={4} />
      {capability === "vision" ? (
        <>
          <label htmlFor="image">PNG image, base64</label>
          <textarea id="image" value={image} onChange={(event) => setImage(event.target.value)} rows={3} />
        </>
      ) : null}
      <button type="submit">Send</button>
      {error ? <p role="alert">{error}</p> : null}
      {output ? <p>{output}</p> : null}
    </form>
  );
}
