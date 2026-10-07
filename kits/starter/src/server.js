import { createServer } from "node:http";
import { createMockAdapter, defineAIConnections } from "@byoki/core";
import { PRICE_CATALOG, estimateCost } from "@byoki/pricing";
import { MANUAL_CATALOG, PROVIDER_LINKS, createProviderAdapters } from "@byoki/providers";
import { createAIConnectionsApp } from "@byoki/server";

const mock = process.env.BYOKI_USE_MOCK !== "0";

function adapters() {
  if (!mock) return createProviderAdapters();
  return {
    openai: createMockAdapter("openai", {
      models: MANUAL_CATALOG.filter((model) => model.provider === "openai"),
    }),
    anthropic: createMockAdapter("anthropic", {
      models: MANUAL_CATALOG.filter((model) => model.provider === "anthropic"),
    }),
    gemini: createMockAdapter("gemini", {
      models: MANUAL_CATALOG.filter((model) => model.provider === "gemini"),
    }),
  };
}

const ai = createAIConnectionsApp({
  config: defineAIConnections({
    appName: "BYOKI starter",
    capabilities: {
      chat: {
        description: "Chat for the developer running this local kit.",
        providers: ["openai", "anthropic", "gemini"],
        userCanChooseModel: true,
        required: true,
      },
    },
  }),
  adapters: adapters(),
  catalog: MANUAL_CATALOG,
  links: PROVIDER_LINKS,
  estimateCost: (args) => estimateCost(PRICE_CATALOG, args),
});

const user = { tenantId: "local", userId: "local-dev" };

function send(res, status, body, extraHeaders) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    ...extraHeaders,
  });
  res.end(payload);
}

function headerPairs(headers) {
  const pairs = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "host" || key.toLowerCase() === "content-length") continue;
    if (typeof value === "string") pairs.push([key, value]);
    else if (Array.isArray(value)) pairs.push([key, value.join(", ")]);
  }
  return pairs;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:8787");
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true, mock });
      return;
    }
    if (!url.pathname.startsWith("/api/ai")) {
      send(res, 404, { ok: false, error: { code: "INVALID_CONFIG", message: "Try GET /health or /api/ai/connections." } });
      return;
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const request = new Request(url, {
      method: req.method,
      headers: headerPairs(req.headers),
      body,
    });
    const response = await ai.handlers.dispatch(request, {
      scope: user,
      csrfHeader: req.headers["x-csrf-token"] ?? "local-dev",
      expectedCsrf: "local-dev",
      origin: null,
      host: null,
    });
    const payload = Buffer.from(await response.arrayBuffer());
    const headers = { "content-length": String(payload.length) };
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-length") return;
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    res.end(payload);
  } catch {
    send(res, 500, {
      ok: false,
      error: { code: "UPSTREAM_UNAVAILABLE", message: "The provider request failed. Try again." },
    });
  }
});

server.listen(8787, "127.0.0.1", () => {
  console.log(`BYOKI starter on http://127.0.0.1:8787 (mock ${mock ? "on" : "off"})`);
});
