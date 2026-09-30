import { afterEach, describe, expect, it } from "vitest";
import { isMockMode, storeMode } from "../lib/env";

const previousMock = process.env.BYOKI_USE_MOCK;
const previousStore = process.env.BYOKI_STORE;

afterEach(() => {
  if (previousMock === undefined) delete process.env.BYOKI_USE_MOCK;
  else process.env.BYOKI_USE_MOCK = previousMock;
  if (previousStore === undefined) delete process.env.BYOKI_STORE;
  else process.env.BYOKI_STORE = previousStore;
});

describe("demo environment", () => {
  it("defaults to mock mode and the memory store", () => {
    delete process.env.BYOKI_USE_MOCK;
    delete process.env.BYOKI_STORE;
    expect(isMockMode()).toBe(true);
    expect(storeMode()).toBe("memory");
  });

  it("keeps BYOKI_USE_MOCK=1 and allows an explicit live opt-in", () => {
    process.env.BYOKI_USE_MOCK = "1";
    expect(isMockMode()).toBe(true);
    process.env.BYOKI_USE_MOCK = "0";
    expect(isMockMode()).toBe(false);
  });
});
