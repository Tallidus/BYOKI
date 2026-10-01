import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip-store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(root, "examples", "next-app", "public", "artifacts");
const packageDirs = ["core", "server", "providers", "pricing", "react"];

function tarballName(packageName, version) {
  return `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertPacked(dir, tarball, packageName) {
  const manifest = execFileSync("tar", ["-xOf", tarball, "package/package.json"], { cwd: dir, encoding: "utf8" });
  const parsed = JSON.parse(manifest);
  if (parsed.name !== packageName) {
    console.error(`${tarball} packed ${parsed.name}, expected ${packageName}`);
    process.exit(1);
  }
  if (JSON.stringify(parsed.dependencies ?? {}).includes("workspace:")) {
    console.error(`${packageName} tarball still has a workspace dependency`);
    process.exit(1);
  }
  const listing = execFileSync("tar", ["-tzf", tarball], { cwd: dir, encoding: "utf8" });
  if (!listing.includes("package/dist/index.js")) {
    console.error(`${packageName} tarball is missing dist/index.js`);
    process.exit(1);
  }
  if (listing.includes(".env") || listing.includes(".data")) {
    console.error(`${packageName} tarball contains secrets or data files`);
    process.exit(1);
  }
}

mkdirSync(artifactDir, { recursive: true });
for (const entry of readdirSync(artifactDir)) {
  if (entry === ".gitkeep") continue;
  rmSync(join(artifactDir, entry), { force: true });
}

const files = [];
for (const dirName of packageDirs) {
  const dir = join(root, "packages", dirName);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (!existsSync(join(dir, "dist", "index.js"))) {
    console.error(`${manifest.name} has no dist/index.js. Build the packages before packing downloads.`);
    process.exit(1);
  }
  const destination = join(root, "node_modules", ".cache", "byoki-pack", dirName);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  execFileSync("corepack", ["pnpm", "pack", "--pack-destination", destination], {
    cwd: dir,
    stdio: "inherit",
  });
  const packedName = readdirSync(destination).find((entry) => entry.endsWith(".tgz"));
  if (!packedName) {
    console.error(`pnpm pack produced no tarball for ${manifest.name}`);
    process.exit(1);
  }
  const expected = tarballName(manifest.name, manifest.version);
  if (packedName !== expected) {
    console.error(`${manifest.name} packed as ${packedName}, expected ${expected}`);
    process.exit(1);
  }
  assertPacked(destination, packedName, manifest.name);
  const data = readFileSync(join(destination, packedName));
  writeFileSync(join(artifactDir, packedName), data);
  files.push({
    file: packedName,
    packageName: manifest.name,
    version: manifest.version,
    bytes: data.length,
    sha256: sha256(data),
  });
  console.log(`packed ${packedName}`);
}

const starterRoot = "byoki-starter";
const kitDir = join(root, "kits", "starter");
const kitFiles = [];

function addKitFile(name, data) {
  kitFiles.push({ name: `${starterRoot}/${name}`, data });
}

function walkKit(dir, prefix = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkKit(full, relative);
    else addKitFile(relative, readFileSync(full));
  }
}

walkKit(kitDir);

const starterDeps = Object.fromEntries(
  files
    .filter((file) => file.packageName !== "@byoki/react")
    .map((file) => [file.packageName, `file:./vendor/${file.file}`]),
);
const packageJson = {
  name: "byoki-starter",
  private: true,
  type: "module",
  packageManager: "pnpm@10.15.1",
  engines: { node: ">=20" },
  scripts: { start: "node --env-file=.env src/server.js" },
  dependencies: starterDeps,
  pnpm: { overrides: starterDeps },
};
addKitFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
for (const file of files.filter((item) => item.packageName !== "@byoki/react")) {
  addKitFile(`vendor/${file.file}`, readFileSync(join(artifactDir, file.file)));
}

const zip = createZip(kitFiles);
const starterName = "byoki-starter.zip";
writeFileSync(join(artifactDir, starterName), zip);
execFileSync("node", ["--check", join(kitDir, "src", "server.js")], { stdio: "inherit" });

const registry = files.map((file) => `${file.packageName}@${file.version}`).join(" ");
const localDeps = Object.fromEntries(files.map((file) => [file.packageName, `file:./${file.file}`]));
const manifest = {
  files,
  starter: { file: starterName, bytes: zip.length, sha256: sha256(zip) },
  tarballInstall: JSON.stringify({ dependencies: localDeps, pnpm: { overrides: localDeps } }, null, 2),
  registryInstall: {
    pnpm: `pnpm add ${registry}`,
    npm: `npm install ${registry}`,
  },
};
writeFileSync(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${starterName} (${zip.length} bytes)`);
