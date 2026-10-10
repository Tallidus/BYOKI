import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AuthContext } from "./handlers.js";

/** Largest request body the Node listener will read before `dispatch`. Matches the invoke cap. */
export const NODE_HTTP_BODY_LIMIT = 1_048_576;

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"]);

export class PayloadTooLargeError extends Error {
  readonly status = 413;
  constructor() {
    super("Request body is too large.");
    this.name = "PayloadTooLargeError";
  }
}

export type NodeHttpServerOptions = {
  dispatch: (request: Request, auth: AuthContext) => Promise<Response>;
  /**
   * Map the incoming request to a scope. For a native client, validate
   * `Authorization: Bearer` here and return `transport: "bearer"`.
   * The bearer token is the app session, not the provider API key.
   */
  authenticate: (request: Request) => Promise<AuthContext> | AuthContext;
};

/**
 * Node HTTP server that forwards each request to a Fetch `dispatch`.
 * Response bodies are written as they arrive, so `text/event-stream` is not buffered.
 * Call `listen` on the returned server. This helper does not choose a port or a user.
 */
export function createNodeHttpServer(options: NodeHttpServerOptions): Server {
  return createServer((req, res) => {
    void handleNodeRequest(req, res, options).catch(() => {
      if (res.headersSent || res.writableEnded) {
        res.end();
        return;
      }
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "UPSTREAM_UNAVAILABLE", message: "The provider request failed. Try again." },
        }),
      );
    });
  });
}

async function handleNodeRequest(req: IncomingMessage, res: ServerResponse, options: NodeHttpServerOptions): Promise<void> {
  let request: Request;
  try {
    request = await readIncomingRequest(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." },
        }),
      );
      return;
    }
    throw error;
  }
  const auth = await options.authenticate(request);
  const response = await options.dispatch(request, auth);
  await writeFetchResponse(res, response);
}

/** Buffer a Node request into a Fetch `Request`, rejecting bodies over `NODE_HTTP_BODY_LIMIT`. */
export async function readIncomingRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && Number(declared) > NODE_HTTP_BODY_LIMIT) {
    req.resume();
    throw new PayloadTooLargeError();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > NODE_HTTP_BODY_LIMIT) {
      req.resume();
      throw new PayloadTooLargeError();
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  const hasBody = body.length > 0 && method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body } : {}),
  });
}

/** Write a Fetch `Response` to Node, including a streaming body. */
export async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  if (res.writableEnded) return;
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}
