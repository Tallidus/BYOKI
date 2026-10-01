import { describe, expect, it } from "vitest";
import { createVisitorMemory } from "../lib/stores";

describe("visitor memory", () => {
  it("isolates keys and drops them when the session expires", async () => {
    let now = 1_000_000;
    const memory = createVisitorMemory(() => now);
    const alice = { tenantId: "demo", userId: "v_a" };
    const bob = { tenantId: "demo", userId: "v_b" };
    memory.activate(alice, now + 1_000);
    memory.activate(bob, now + 5_000);
    await memory.credentials.put(alice, "openai", "demo-mock-key");
    await memory.credentials.put(bob, "openai", "other-mock-key");
    expect(await memory.credentials.get(bob, "openai")).toBe("other-mock-key");
    expect(await memory.credentials.get(alice, "openai")).toBe("demo-mock-key");
    now += 1_001;
    expect(await memory.credentials.get(alice, "openai")).toBeNull();
    expect(await memory.credentials.has(alice, "openai")).toBe(false);
    expect(await memory.credentials.get(bob, "openai")).toBe("other-mock-key");
    memory.forget(bob);
    expect(await memory.credentials.has(bob, "openai")).toBe(false);
  });
});
