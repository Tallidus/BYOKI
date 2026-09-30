import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMockAdapter, defineAIConnections, type ModelOption } from "@byoki/core";
import { createEncryptedFileStore, decodeMasterKey } from "../src/index.js";
import { createHandlers, type AuthContext } from "../src/handlers.js";
import { createRateLimiter } from "../src/rate-limit.js";
import { createRedactingLogger } from "../src/redact.js";

const catalog: ModelOption[] = [
  {
    id: "openai-mock-chat",
    provider: "openai",
    capabilities: ["chat", "vision"],
    displayName: "OpenAI mock",
    catalogUpdatedAt: "2026-09-25T00:00:00.000Z",
    source: "catalog",
    availabilityCaveat: "May be unavailable.",
  },
];

const links = {
  openai: { keys: "https://platform.openai.com/api-keys", usage: "https://platform.openai.com/usage", billing: "https://platform.openai.com/settings/organization/billing", reviewedAt: "2026-09-25" },
  anthropic: { keys: "https://platform.claude.com/settings/keys", usage: "https://platform.claude.com/usage", billing: "https://platform.claude.com/settings/billing", reviewedAt: "2026-09-25" },
  gemini: { keys: "https://aistudio.google.com/apikey", usage: "https://aistudio.google.com/usage", billing: "https://console.cloud.google.com/billing", reviewedAt: "2026-09-25" },
} as const;

function auth(userId: string, csrf = "token"): AuthContext {
  return {
    scope: { tenantId: "local", userId },
    csrfHeader: csrf,
    expectedCsrf: csrf,
    origin: "http://localhost:3000",
    host: "localhost:3000",
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "byoki-"));
  const file = join(dir, "store.json");
  const key = decodeMasterKey(randomBytes(32).toString("base64"));
  const store = createEncryptedFileStore(file, key);
  const logs: string[] = [];
  const handlers = createHandlers({
    config: defineAIConnections({
      appName: "Garage Assistant",
      capabilities: {
        chat: { description: "Chat", providers: ["openai", "anthropic", "gemini"], required: true },
        vision: { description: "Vision", providers: ["openai", "gemini"] },
      },
    }),
    credentials: store.credentials,
    selections: store.selections,
    ledger: store.ledger,
    adapters: {
      openai: createMockAdapter("openai", { models: catalog }),
      anthropic: createMockAdapter("anthropic"),
      gemini: createMockAdapter("gemini"),
    },
    catalog,
    links: { ...links },
    rateLimit: createRateLimiter(5, 60_000),
    logger: createRedactingLogger((line) => logs.push(line)),
  });
  return { handlers, file, logs, store };
}

describe("connection isolation and secrets", () => {
  it("rejects cross-user reads and writes", async () => {
    const { handlers } = await setup();
    const secret = "sk-alice-secret-key-123456";
    const saved = await handlers.putConnection(auth("alice"), "openai", jsonRequest({ apiKey: secret }));
    expect(saved.status).toBe(200);
    const alice = await handlers.getConnections(auth("alice"));
    const bob = await handlers.getConnections(auth("bob"));
    const aliceBody = await alice.json();
    const bobBody = await bob.json();
    expect(aliceBody.data.providers.find((item: { id: string }) => item.id === "openai").status).toBe("connected");
    expect(bobBody.data.providers.find((item: { id: string }) => item.id === "openai").status).toBe("disconnected");
    expect(JSON.stringify(aliceBody)).not.toContain(secret);
    expect(JSON.stringify(bobBody)).not.toContain(secret);
    const bobDelete = await handlers.deleteConnection(auth("bob"), "openai");
    expect(bobDelete.status).toBe(200);
    const aliceAfter = await (await handlers.getConnections(auth("alice"))).json();
    expect(aliceAfter.data.providers.find((item: { id: string }) => item.id === "openai").status).toBe("connected");
  });

  it("keeps the plaintext key out of the store file and logs", async () => {
    const { handlers, file, logs } = await setup();
    const secret = "sk-alice-secret-key-123456";
    await handlers.putConnection(auth("alice"), "openai", jsonRequest({ apiKey: secret }));
    const onDisk = await readFile(file, "utf8");
    expect(onDisk).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
    const listed = await (await handlers.getConnections(auth("alice"))).json();
    expect(JSON.stringify(listed)).not.toContain(secret);
  });

  it("rejects a missing csrf token and a foreign origin", async () => {
    const { handlers } = await setup();
    const missing = await handlers.dispatch(jsonRequest({ apiKey: "sk-not-used-0000" }, "PUT", "/api/ai/connections/openai"), {
      ...auth("alice"),
      csrfHeader: null,
    });
    expect(missing.status).toBe(401);
    const foreign = await handlers.dispatch(jsonRequest({ apiKey: "sk-not-used-0000" }, "PUT", "/api/ai/connections/openai"), {
      ...auth("alice"),
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(401);
  });

  it("does not accept an unknown provider id", async () => {
    const { handlers } = await setup();
    const response = await handlers.dispatch(
      jsonRequest({ apiKey: "sk-not-used-0000" }, "PUT", "/api/ai/connections/https%3A%2F%2Fevil.example"),
      auth("alice"),
    );
    expect(response.status).toBe(403);
  });

  it("lists models only for connected providers", async () => {
    const { handlers } = await setup();
    await handlers.putConnection(auth("alice"), "openai", jsonRequest({ apiKey: "valid-key-alice" }));
    const response = await handlers.dispatch(
      new Request("http://localhost:3000/api/ai/models?capability=chat"),
      auth("alice"),
    );
    const body = await response.json();
    expect(body.data.models.every((model: { provider: string }) => model.provider === "openai")).toBe(true);
    expect(body.data.models.length).toBeGreaterThan(0);
  });
});

function jsonRequest(body: unknown, method = "PUT", path = "/api/ai/connections/openai"): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
