import { afterEach, describe, expect, it } from "vitest";
import { publicHost, redirectLocation, resolvePublicOrigin } from "../lib/http";

const originalHost = process.env.BYOKI_PUBLIC_HOST;
const originalOrigin = process.env.BYOKI_PUBLIC_ORIGIN;

afterEach(() => {
  if (originalHost === undefined) delete process.env.BYOKI_PUBLIC_HOST;
  else process.env.BYOKI_PUBLIC_HOST = originalHost;
  if (originalOrigin === undefined) delete process.env.BYOKI_PUBLIC_ORIGIN;
  else process.env.BYOKI_PUBLIC_ORIGIN = originalOrigin;
});

function request(url: string, headers: Record<string, string>): Request {
  return new Request(url, { headers });
}

describe("public redirects", () => {
  it("uses the forwarded public host and https", () => {
    const incoming = request("http://127.0.0.1:3004/api/session?next=/demo", {
      "x-forwarded-host": "byoki.eastonnielson.dev",
      "x-forwarded-proto": "https",
      host: "127.0.0.1:3004",
    });
    expect(resolvePublicOrigin(incoming)).toBe("https://byoki.eastonnielson.dev");
    expect(redirectLocation(incoming, "/demo")).toBe("https://byoki.eastonnielson.dev/demo");
    expect(publicHost(incoming)).toBe("byoki.eastonnielson.dev");
  });

  it("does not emit a localhost absolute URL when the forwarded host is untrusted", () => {
    const incoming = request("http://127.0.0.1:3004/api/session", {
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      host: "127.0.0.1:3004",
    });
    expect(redirectLocation(incoming, "/demo")).toBe("/demo");
    expect(redirectLocation(incoming, "/demo")).not.toContain("localhost");
    expect(redirectLocation(incoming, "/demo")).not.toContain("127.0.0.1");
  });

  it("keeps localhost for a direct local request", () => {
    const incoming = request("http://localhost:3000/demo", { host: "localhost:3000" });
    expect(resolvePublicOrigin(incoming)).toBe("http://localhost:3000");
  });

  it("allows an extra public host from the environment", () => {
    process.env.BYOKI_PUBLIC_HOST = "preview.example.com";
    const incoming = request("http://127.0.0.1:3004/demo", {
      "x-forwarded-host": "preview.example.com",
      "x-forwarded-proto": "https",
    });
    expect(resolvePublicOrigin(incoming)).toBe("https://preview.example.com");
  });
});
