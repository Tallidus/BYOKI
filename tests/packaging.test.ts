import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package boundaries", () => {
  it("keeps the browser entry free of server and credential code", () => {
    const source = readFileSync("packages/core/src/browser.ts", "utf8");
    expect(source).not.toMatch(/node:crypto|CredentialStore|createRouter|encrypt/);
    const reactPkg = JSON.parse(readFileSync("packages/react/package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(reactPkg.dependencies?.["@byoki/server"]).toBeUndefined();
    const client = readFileSync("packages/react/src/client.ts", "utf8");
    expect(client).not.toMatch(/localStorage|sessionStorage/);
  });
});
