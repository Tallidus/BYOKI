import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOST_ROUTES } from "../lib/routes";

const root = join(process.cwd(), "..", "..");

describe("generated docs", () => {
  it("lists the public package API and the demo environment", () => {
    execFileSync(process.execPath, [join(root, "scripts", "generate-api-docs.mjs")], { cwd: root });
    const api = JSON.parse(readFileSync(join(root, "examples", "next-app", "lib", "generated", "api.json"), "utf8")) as {
      packages: Array<{ name: string; entries: Array<{ symbols: Array<{ name: string }> }> }>;
      env: Array<{ name: string }>;
    };
    const names = api.packages.flatMap((pkg) => pkg.entries.flatMap((entry) => entry.symbols.map((symbol) => symbol.name)));
    expect(names).toContain("defineAIConnections");
    expect(names).toContain("createAIConnectionsApp");
    expect(names).toContain("createProviderAdapters");
    expect(names).toContain("estimateCost");
    expect(names).toContain("AIConnectionsSettings");
    expect(api.env.map((item) => item.name)).toEqual(
      expect.arrayContaining(["SESSION_SECRET", "BYOKI_MASTER_KEY", "BYOKI_USE_MOCK", "BYOKI_STORE", "BYOKI_SESSION_TTL_SECONDS"]),
    );
  });

  it("documents routes that the server handlers still implement", () => {
    const handlers = readFileSync(join(root, "packages", "server", "src", "handlers.ts"), "utf8");
    for (const route of HOST_ROUTES) {
      const pathOnly = route.path.split("?")[0] ?? route.path;
      const segment = pathOnly.split("/").find((part) => part && !part.startsWith(":") && part !== "api" && part !== "ai");
      expect(segment).toBeTruthy();
      expect(handlers).toContain(`"${segment}"`);
    }
  });
});