import { afterAll, describe, expect, it } from "vitest";
import type { Scope } from "@byoki/core";
import { connectSample } from "../lib/sample";
import { activateVisitor, forgetVisitor, getServices } from "../lib/services";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";
process.env.BYOKI_USE_MOCK = "1";
process.env.BYOKI_STORE = "memory";

const scopeA: Scope = { tenantId: "demo", userId: "v_sample-a" };
const scopeB: Scope = { tenantId: "demo", userId: "v_sample-b" };

function auth(scope: Scope) {
  return { scope, csrfHeader: null, expectedCsrf: null, origin: null, host: null };
}

describe("sample connection", () => {
  afterAll(async () => {
    await forgetVisitor(scopeA);
    await forgetVisitor(scopeB);
  });

  it("saves a mock key for one visitor and leaves the other disconnected", async () => {
    const exp = Date.now() + 60_000;
    await activateVisitor(scopeA, exp);
    await activateVisitor(scopeB, exp);
    await connectSample(scopeA);
    const services = getServices();
    const connected = await (await services.handlers.getConnections(auth(scopeA))).json();
    const other = await (await services.handlers.getConnections(auth(scopeB))).json();
    expect(connected.data.providers.find((item: { id: string }) => item.id === "openai").status).toBe("connected");
    expect(other.data.providers.find((item: { id: string }) => item.id === "openai").status).toBe("disconnected");
    expect(JSON.stringify(connected)).not.toContain("demo-mock-key");
    const chat = connected.data.capabilities.find((item: { id: string }) => item.id === "chat");
    expect(chat.selection.modelId).toBe("gpt-5.6-terra");
    await forgetVisitor(scopeA);
    const after = await (await services.handlers.getConnections(auth(scopeA))).json();
    expect(after.data.providers.find((item: { id: string }) => item.id === "openai").status).toBe("disconnected");
  });
});
