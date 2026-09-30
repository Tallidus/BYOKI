import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packages = ["core", "server", "providers", "pricing", "react"];
const tarballs = new Map();

for (const name of packages) {
  const dir = join("packages", name);
  for (const existing of readdirSync(dir)) {
    if (existing.endsWith(".tgz")) rmSync(join(dir, existing));
  }
  execSync("corepack pnpm pack --pack-destination .", { cwd: dir, stdio: "inherit" });
  const tarball = readdirSync(dir).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) {
    console.error(`No tarball for ${name}`);
    process.exit(1);
  }
  const packed = execSync(`tar -tzf ${tarball}`, { cwd: dir, encoding: "utf8" });
  if (packed.includes(".env") || packed.includes(".data")) {
    console.error(`${name} tarball contains secrets or data files`);
    process.exit(1);
  }
  if (!packed.includes("package/dist/index.js")) {
    console.error(`${name} tarball is missing dist/index.js`);
    process.exit(1);
  }
  const manifest = execSync(`tar -xOf ${tarball} package/package.json`, { cwd: dir, encoding: "utf8" });
  const parsed = JSON.parse(manifest);
  if (parsed.license !== "MIT") {
    console.error(`${name} is missing the MIT license field`);
    process.exit(1);
  }
  if (!parsed.exports?.["."]?.import) {
    console.error(`${name} is missing an ESM export`);
    process.exit(1);
  }
  if (JSON.stringify(parsed.dependencies ?? {}).includes("workspace:")) {
    console.error(`${name} still has a workspace dependency`);
    process.exit(1);
  }
  tarballs.set(name, join(dir, tarball));
  console.log(`${name} pack ok`);
}

const consumer = mkdtempSync(join(tmpdir(), "byoki-consumer-"));
const dependencies = {};
for (const [name, file] of tarballs) {
  dependencies[`@byoki/${name}`] = `file:${resolve(file).replaceAll("\\", "/")}`;
}
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify(
    {
      name: "byoki-consumer",
      private: true,
      type: "module",
      packageManager: "pnpm@10.15.1",
      dependencies,
      pnpm: { overrides: dependencies },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(consumer, "check.mjs"),
  `import { defineAIConnections } from "@byoki/core";
const config = defineAIConnections({
  appName: "Installed app",
  capabilities: { chat: { description: "Chat", providers: ["openai"] } },
});
if (config.appName !== "Installed app") process.exit(1);
console.log("consumer import ok");
`,
);
try {
  execSync("corepack pnpm install --ignore-workspace", { cwd: consumer, stdio: "inherit" });
  execSync("node check.mjs", { cwd: consumer, stdio: "inherit" });
  const installed = JSON.parse(readFileSync(join(consumer, "node_modules", "@byoki", "server", "package.json"), "utf8"));
  if (String(installed.dependencies["@byoki/core"] ?? "").startsWith("workspace:")) {
    console.error("Installed server package still points at the workspace");
    process.exit(1);
  }
  console.log("clean install ok");
} finally {
  for (const file of tarballs.values()) rmSync(file, { force: true });
  rmSync(consumer, { recursive: true, force: true });
}
