import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "examples", "next-app", "lib", "generated", "api.json");

const ENV = [
  {
    name: "SESSION_SECRET",
    required: "Required to run the demo site",
    usedBy: "Demo session cookie",
    description:
      "HMAC secret for anonymous demo session cookies. Generate a long random string and keep it out of git.",
  },
  {
    name: "BYOKI_MASTER_KEY",
    required: "Required for the development file store",
    usedBy: "@byoki/server file store and BYOKI_STORE=file",
    description:
      "32-byte key encoded as base64 or hex. Encrypts credentials in the development file store. It is not written into that file. The public demo's default memory store does not read it.",
  },
  {
    name: "BYOKI_USE_MOCK",
    required: "Defaults to mock mode when unset",
    usedBy: "Demo site and starter kit",
    description:
      "Set to 1 to answer requests with the mock adapters and make no provider calls. Set to 0 to send the signed-in user's key to OpenAI, Anthropic, or Gemini. Leave this at 1 on the public demo.",
  },
  {
    name: "BYOKI_STORE",
    required: "Defaults to memory",
    usedBy: "Demo site",
    description:
      "memory keeps each visitor's key in the Node process until the session expires, the visitor ends the session, or the process restarts. file uses the encrypted development store at .data/store.json and should not be used for the public demo.",
  },
  {
    name: "BYOKI_SESSION_TTL_SECONDS",
    required: "Defaults to 7200",
    usedBy: "Demo site",
    description:
      "Lifetime of an anonymous demo session in seconds. Values are clamped to the range 300–86400. The cookie Max-Age uses the same value.",
  },
  {
    name: "BYOKI_PUBLIC_HOST",
    required: "Optional",
    usedBy: "Demo site redirects",
    description:
      "Comma-separated extra hostnames allowed when building redirects from X-Forwarded-Host. byoki.eastonnielson.dev, localhost, and 127.0.0.1 are always allowed. Other forwarded hosts are ignored.",
  },
  {
    name: "BYOKI_PUBLIC_ORIGIN",
    required: "Defaults to https://byoki.eastonnielson.dev",
    usedBy: "Demo site metadata and redirect allow list",
    description:
      "Absolute origin of the deployed site, used for metadata. Its hostname is also allowed for proxy redirects.",
  },
  {
    name: "OPENAI_API_KEY",
    required: "Test only",
    usedBy: "Opt-in provider smoke tests",
    description:
      "Read only when BYOKI_LIVE=1 runs the provider package smoke tests. The demo site does not use this variable. Visitors supply their own keys.",
    testOnly: true,
  },
  {
    name: "ANTHROPIC_API_KEY",
    required: "Test only",
    usedBy: "Opt-in provider smoke tests",
    description:
      "Read only when BYOKI_LIVE=1 runs the provider package smoke tests. The demo site does not use this variable.",
    testOnly: true,
  },
  {
    name: "GEMINI_API_KEY",
    required: "Test only",
    usedBy: "Opt-in provider smoke tests",
    description:
      "Read only when BYOKI_LIVE=1 runs the provider package smoke tests. The demo site does not use this variable.",
    testOnly: true,
  },
  {
    name: "BYOKI_LIVE",
    required: "Test only",
    usedBy: "Opt-in provider smoke tests",
    description: "Set to 1 to run live OpenAI, Anthropic, and Gemini smoke tests. Leave it unset in CI and on the public demo.",
    testOnly: true,
  },
];

const PACKAGES = [
  {
    dir: "core",
    entries: [
      { subpath: ".", file: "src/index.ts" },
      { subpath: "./browser", file: "src/browser.ts" },
    ],
  },
  { dir: "server", entries: [{ subpath: ".", file: "src/index.ts" }] },
  { dir: "providers", entries: [{ subpath: ".", file: "src/index.ts" }] },
  { dir: "pricing", entries: [{ subpath: ".", file: "src/index.ts" }] },
  { dir: "react", entries: [{ subpath: ".", file: "src/index.ts" }] },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next" || entry.name === "generated") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function isTestFile(file) {
  return file.includes(`${join("test", "")}`) || file.endsWith(".test.ts") || file.endsWith(".test.tsx");
}

function scanEnv(files) {
  const found = new Set();
  const pattern = /process\.env\.([A-Z0-9_]+)/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

function assertEnvDocumented() {
  const files = [
    ...walk(join(root, "packages")),
    ...walk(join(root, "examples", "next-app")),
    ...walk(join(root, "kits")),
    ...walk(join(root, "scripts")),
  ];
  const runtime = scanEnv(files.filter((file) => !isTestFile(file)));
  const tests = scanEnv(files.filter((file) => isTestFile(file)));
  const known = new Map(ENV.map((item) => [item.name, item]));
  for (const name of runtime) {
    const item = known.get(name);
    if (!item) {
      console.error(`Undocumented environment variable ${name}. Add it to scripts/generate-api-docs.mjs, README.md, and .env.example.`);
      process.exit(1);
    }
    if (item.testOnly) {
      console.error(`${name} is marked test-only but is read outside tests.`);
      process.exit(1);
    }
  }
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const example = readFileSync(join(root, "examples", "next-app", ".env.example"), "utf8");
  for (const item of ENV) {
    const seen = runtime.has(item.name) || tests.has(item.name);
    if (!seen) {
      console.error(`Environment variable ${item.name} is documented but no longer read.`);
      process.exit(1);
    }
    if (!example.includes(item.name) || !readme.includes(item.name)) {
      console.error(`${item.name} must appear in README.md and examples/next-app/.env.example.`);
      process.exit(1);
    }
  }
}

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function directDeclaration(statement, name) {
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name?.text === name
  ) {
    return statement;
  }
  if (ts.isVariableStatement(statement)) {
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return statement;
    }
  }
  return null;
}

function locate(file, name, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const source = parse(file);
  for (const statement of source.statements) {
    const direct = directDeclaration(statement, name);
    if (direct) return { source, node: direct };
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const exported = element.name.text;
        const local = (element.propertyName ?? element.name).text;
        if (exported !== name) continue;
        const next = resolveSpecifier(file, statement.moduleSpecifier.text);
        if (!next) continue;
        const found = locate(next, local, seen);
        if (found) return found;
      }
    }
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        const local = element.name.text;
        const imported = (element.propertyName ?? element.name).text;
        if (local !== name) continue;
        const next = resolveSpecifier(file, statement.moduleSpecifier.text);
        if (!next) continue;
        const found = locate(next, imported, seen);
        if (found) return found;
      }
    }
  }
  return null;
}

function exportedNames(file) {
  const source = parse(file);
  const names = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        names.push({
          name: element.name.text,
          local: (element.propertyName ?? element.name).text,
          typeOnly: statement.isTypeOnly || element.isTypeOnly,
        });
      }
    } else if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
        if (statement.name) names.push({ name: statement.name.text, local: statement.name.text, typeOnly: false });
      } else if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) names.push({ name: decl.name.text, local: decl.name.text, typeOnly: false });
        }
      }
    }
  }
  return names;
}

function docsFor(source, node) {
  const text = source.text.slice(node.getFullStart(), node.getStart(source));
  const match = text.match(/\/\*\*[\s\S]*?\*\//);
  if (!match) return "";
  return match[0]
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => line && !line.startsWith("@"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function kindOf(node, typeOnly) {
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isVariableStatement(node)) return typeOnly ? "type" : "const";
  if (typeOnly) return "type";
  return "value";
}

function signatureOf(source, node, name) {
  if (ts.isFunctionDeclaration(node)) {
    const typeParams = node.typeParameters?.length
      ? `<${node.typeParameters.map((item) => item.getText(source)).join(", ")}>`
      : "";
    const params = node.parameters.map((param) => param.getText(source)).join(", ");
    const ret = node.type ? `: ${node.type.getText(source)}` : "";
    const asyncKeyword = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? "async " : "";
    return `${asyncKeyword}function ${name}${typeParams}(${params})${ret}`;
  }
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === name);
    const init = decl?.initializer?.getText(source) ?? "";
    const type = decl?.type?.getText(source);
    if (init.length > 1200) return type ? `const ${name}: ${type}` : `const ${name}`;
    if (type && init) return `const ${name}: ${type} = ${init}`;
    if (init) return `const ${name} = ${init}`;
    return `const ${name}`;
  }
  const text = node.getText(source);
  if (text.length > 2500) return `${text.slice(0, 2500)}\n/* truncated */`;
  return text;
}

function documentPackage(pkgJson, entry) {
  const file = join(root, "packages", pkgJson.dir, entry.file);
  const symbols = exportedNames(file).map((item) => {
    const located = locate(file, item.local);
    if (!located) {
      console.error(`Could not locate ${item.name} from ${file}`);
      process.exit(1);
    }
    return {
      name: item.name,
      kind: kindOf(located.node, item.typeOnly),
      signature: signatureOf(located.source, located.node, item.name),
      docs: docsFor(located.source, located.node),
    };
  });
  symbols.sort((a, b) => a.name.localeCompare(b.name));
  const importFrom = entry.subpath === "." ? pkgJson.name : `${pkgJson.name}${entry.subpath.slice(1)}`;
  return { subpath: entry.subpath, importFrom, symbols };
}

assertEnvDocumented();

const packages = PACKAGES.map((item) => {
  const manifest = JSON.parse(readFileSync(join(root, "packages", item.dir, "package.json"), "utf8"));
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    engines: manifest.engines?.node ?? "",
    entries: item.entries.map((entry) => documentPackage({ ...item, name: manifest.name }, entry)),
  };
});

const installSpecs = packages.map((item) => `${item.name}@${item.version}`).join(" ");
const api = {
  packages,
  env: ENV.map(({ name, required, usedBy, description }) => ({ name, required, usedBy, description })),
  install: {
    pnpm: `pnpm add ${installSpecs}`,
    npm: `npm install ${installSpecs}`,
  },
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(api, null, 2)}\n`);
console.log(`wrote ${packages.reduce((sum, item) => sum + item.entries.reduce((inner, entry) => inner + entry.symbols.length, 0), 0)} symbols`);
