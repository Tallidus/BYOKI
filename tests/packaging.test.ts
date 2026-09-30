import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createZip } from "../scripts/zip-store.mjs";

function dosDate(zip: Buffer) {
  const date = zip.readUInt16LE(12);
  return { year: (date >> 9) + 1980, month: (date >> 5) & 15, day: date & 31 };
}

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

  it("writes a legal DOS date into zip entries", () => {
    const early = createZip([{ name: "a.txt", data: "hi" }], new Date(1979, 0, 1));
    expect(dosDate(early)).toEqual({ year: 1980, month: 1, day: 1 });
    const real = createZip([{ name: "a.txt", data: "hi" }], new Date(2026, 8, 30, 15, 4, 6));
    expect(dosDate(real)).toEqual({ year: 2026, month: 9, day: 30 });
  });
});
