import { describe, expect, it } from "vitest";
import {
  AIConnectionsError,
  createMockAdapter,
  defineAIConnections,
  type ModelOption,
  type ProviderStreamEvent,
} from "@byoki/core";
import { createAIConnectionsApp, createNodeHttpServer, type AuthContext } from "../src/index.js";
import { createMemoryCredentialStore, createMemoryLedger, createMemorySelectionStore } from "../src/memory.js";
import { createRedactingLogger } from "../src/redact.js";

const model: ModelOption = {
  id: "openai-mock-chat",
  provider: "openai",
  capabilities: ["chat", "vision"],
  displayName: "OpenAI mock",
  catalogUpdatedAt: "2026-09-25T00:00:00.000Z",
  source: "catalog",
  availabilityCaveat: "May be unavailable.",
};

const links = {
  openai: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
  anthropic: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
  gemini: { keys: "https://example.com/keys", usage: "https://example.com/usage", billing: "https://example.com/billing", reviewedAt: "2026-09-25" },
} as const;

const secret = "sk-alice-secret-key-123456";

function cookieAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: { tenantId: "local", userId: "user-a" },
    csrfHeader: "token",
    expectedCsrf: "token",
    origin: "http://localhost:3000",
    host: "localhost:3000",
    ...overrides,
  };
}

function bearerAuth(): AuthContext {
  return {
    scope: { tenantId: "local", userId: "user-a" },
    csrfHeader: null,
    expectedCsrf: null,
    origin: null,
    host: null,
    transport: "bearer",
  };
}

function appFor(adapter = createMockAdapter("openai", { models: [model] })) {
  const logs: string[] = [];
  const credentials = createMemoryCredentialStore();
  const selections = createMemorySelectionStore();
  const ledger = createMemoryLedger();
  const ai = createAIConnectionsApp({
    config: defineAIConnections({
      appName: "Sample app",
      capabilities: {
        chat: { description: "Chat", providers: ["openai"], required: true },
        vision: { description: "Vision", providers: ["openai"] },
      },
    }),
    adapters: { openai: adapter },
    catalog: [model],
    links: { ...links },
    estimateCost: () => ({ status: "known", currency: "USD", amount: 0.01, catalogVersion: "test" }),
    credentials,
    selections,
    ledger,
    logger: createRedactingLogger((line) => logs.push(line)),
  });
  return { ai, logs, credentials, selections, ledger };
}

function jsonRequest(body: unknown, method: string, path: string): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("HTTP invoke", () => {
  it("returns JSON for a buffered call and keeps the key out of the response, logs, and ledger", async () => {
    const { ai, logs } = appFor();
    const saved = await ai.handlers.dispatch(
      jsonRequest({ apiKey: secret }, "PUT", "/api/ai/connections/openai"),
      cookieAuth(),
    );
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.clone().json())).not.toContain(secret);
    await ai.handlers.dispatch(
      jsonRequest({ provider: "openai", modelId: model.id }, "PUT", "/api/ai/selections/chat"),
      cookieAuth(),
    );
    const response = await ai.handlers.dispatch(
      jsonRequest(
        { capability: "chat", input: [{ role: "user", text: "Hello from the app" }] },
        "POST",
        "/api/ai/invoke",
      ),
      cookieAuth(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.outputText).toContain("mock:chat:Hello from the app");
    expect(body.data.provider).toBe("openai");
    expect(body.data.modelId).toBe(model.id);
    expect(body.data.estimationStatus).toBe("known");
    expect(JSON.stringify(body)).not.toContain(secret);
    const usage = await (
      await ai.handlers.dispatch(new Request("http://127.0.0.1/api/ai/usage"), cookieAuth())
    ).json();
    expect(JSON.stringify(usage)).not.toContain(secret);
    expect(JSON.stringify(usage)).not.toContain("Hello from the app");
    expect(logs.join("\n")).not.toContain(secret);
    expect(logs.join("\n")).not.toContain("Hello from the app");
  });

  it("streams SSE when stream is true and returns JSON errors before the first token", async () => {
    const { ai } = appFor();
    await ai.handlers.dispatch(jsonRequest({ apiKey: secret }, "PUT", "/api/ai/connections/openai"), bearerAuth());
    await ai.handlers.dispatch(
      jsonRequest({ provider: "openai", modelId: model.id }, "PUT", "/api/ai/selections/chat"),
      bearerAuth(),
    );
    const response = await ai.handlers.dispatch(
      jsonRequest(
        { capability: "chat", stream: true, input: [{ role: "user", text: "Hello" }] },
        "POST",
        "/api/ai/invoke",
      ),
      bearerAuth(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const raw = await response.text();
    expect(raw).toContain("event: delta");
    expect(raw).toContain("event: done");
    expect(raw).not.toContain(secret);
    const done = raw
      .split("\n\n")
      .filter((block) => block.includes("event: done"))
      .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data:"))?.slice(6) ?? "{}"));
    expect(done[0]?.ok).toBe(true);
    expect(done[0]?.data.outputText).toContain("mock:chat:Hello");

    const missing = await ai.handlers.dispatch(
      jsonRequest(
        { capability: "vision", stream: true, input: [{ role: "user", text: "photo" }] },
        "POST",
        "/api/ai/invoke",
      ),
      bearerAuth(),
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
    const errorBody = await missing.json();
    expect(errorBody).toMatchObject({ ok: false, error: { code: "MODEL_UNAVAILABLE" } });
    expect(JSON.stringify(errorBody)).not.toContain("event:");
  });

  it("rejects a cookie invoke without CSRF and accepts a bearer invoke without it", async () => {
    const { ai } = appFor();
    const denied = await ai.handlers.dispatch(
      jsonRequest({ capability: "chat", input: [{ role: "user", text: "Hi" }] }, "POST", "/api/ai/invoke"),
      cookieAuth({ csrfHeader: null }),
    );
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ ok: false, error: { code: "CSRF_FAILED" } });

    const anonymous = await ai.handlers.dispatch(
      jsonRequest({ capability: "chat", input: [{ role: "user", text: "Hi" }] }, "POST", "/api/ai/invoke"),
      { ...bearerAuth(), scope: null },
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  it("rejects a bad image and a key body over 8 KiB", async () => {
    const { ai } = appFor();
    const image = await ai.handlers.dispatch(
      jsonRequest(
        {
          capability: "vision",
          input: [{ role: "user", parts: [{ type: "image", mimeType: "image/svg+xml", data: "aaaa" }] }],
        },
        "POST",
        "/api/ai/invoke",
      ),
      bearerAuth(),
    );
    expect(image.status).toBe(400);
    expect(await image.json()).toMatchObject({ ok: false, error: { code: "INVALID_CONFIG" } });

    const oversized = await ai.handlers.dispatch(
      jsonRequest({ apiKey: `sk-${"a".repeat(9000)}` }, "PUT", "/api/ai/connections/openai"),
      bearerAuth(),
    );
    expect(oversized.status).toBe(413);
  });

  it("turns a failure after the first delta into an SSE error and does not echo provider text", async () => {
    const adapter = createMockAdapter("openai", { models: [model] });
    const failing = {
      ...adapter,
      async *invokeStream(): AsyncGenerator<ProviderStreamEvent> {
        yield { type: "delta", text: "partial" };
        throw new AIConnectionsError("UPSTREAM_UNAVAILABLE", `provider said ${secret}`);
      },
    };
    const { ai, logs } = appFor(failing);
    await ai.handlers.dispatch(jsonRequest({ apiKey: secret }, "PUT", "/api/ai/connections/openai"), bearerAuth());
    await ai.handlers.dispatch(
      jsonRequest({ provider: "openai", modelId: model.id }, "PUT", "/api/ai/selections/chat"),
      bearerAuth(),
    );
    const response = await ai.handlers.dispatch(
      jsonRequest(
        { capability: "chat", stream: true, input: [{ role: "user", text: "Hello from the app" }] },
        "POST",
        "/api/ai/invoke",
      ),
      bearerAuth(),
    );
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).toContain("event: delta");
    expect(raw).toContain("event: error");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("provider said");
    expect(logs.join("\n")).not.toContain(secret);
    const usage = await (
      await ai.handlers.dispatch(new Request("http://127.0.0.1/api/ai/usage"), bearerAuth())
    ).json();
    expect(usage.data.failures).toBe(1);
    expect(JSON.stringify(usage)).not.toContain("Hello from the app");
  });

  it("flushes SSE through the Node server before the rest of the stream is ready", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createMockAdapter("openai", { models: [model] });
    const gated = {
      ...adapter,
      async *invokeStream(): AsyncGenerator<ProviderStreamEvent> {
        yield { type: "delta", text: "one" };
        await gate;
        yield { type: "delta", text: "two" };
        yield {
          type: "done",
          output: [{ type: "text", text: "onetwo" }],
          latencyMs: 1,
          usageGaps: [],
        };
      },
    };
    const { ai, credentials, selections } = appFor(gated);
    const scope = { tenantId: "local", userId: "user-a" };
    await credentials.put(scope, "openai", secret);
    await selections.put(scope, { capability: "chat", provider: "openai", modelId: model.id });
    const server = createNodeHttpServer({
      dispatch: (request, auth) => ai.handlers.dispatch(request, auth),
      authenticate: () => bearerAuth(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP port.");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ai/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer session-token" },
        body: JSON.stringify({ capability: "chat", stream: true, input: [{ role: "user", text: "Hello" }] }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing body.");
      const decoder = new TextDecoder();
      let raw = "";
      const first = await Promise.race([
        (async () => {
          while (!raw.includes("\"text\":\"one\"")) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) raw += decoder.decode(value, { stream: true });
          }
          return raw;
        })(),
        new Promise<string>((_resolve, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for the first delta")), 2000);
        }),
      ]);
      expect(first).toContain("one");
      expect(first).not.toContain("two");
      release();
      const finished = await Promise.race([
        (async () => {
          while (!raw.includes("event: done")) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) raw += decoder.decode(value, { stream: true });
          }
          return raw;
        })(),
        new Promise<string>((_resolve, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for the done event")), 2000);
        }),
      ]);
      raw = finished;
      expect(raw).toContain("two");
      expect(raw).toContain("onetwo");
      expect(raw).not.toContain(secret);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
