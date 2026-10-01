const ALWAYS_ALLOWED = new Set(["byoki.eastonnielson.dev", "localhost", "127.0.0.1", "::1"]);

function hostnameOf(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || /[\s/@\\]/.test(trimmed)) return "";
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1 ? trimmed.slice(1, end) : "";
  }
  return trimmed.split(":")[0] ?? "";
}

function allowedHosts(): Set<string> {
  const hosts = new Set(ALWAYS_ALLOWED);
  const extra = process.env.BYOKI_PUBLIC_HOST;
  if (extra) {
    for (const part of extra.split(",")) {
      const name = hostnameOf(part);
      if (name) hosts.add(name);
    }
  }
  const origin = process.env.BYOKI_PUBLIC_ORIGIN;
  if (origin) {
    try {
      hosts.add(new URL(origin).hostname.toLowerCase());
    } catch {
      // Layout validation reports a bad origin. Ignore it for redirects.
    }
  }
  return hosts;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Origin used for redirects behind nginx and a Cloudflare tunnel.
 * Unrecognized forwarded hosts are ignored so a proxy header cannot send browsers to another site.
 */
export function resolvePublicOrigin(request: Request): string {
  const requestUrl = new URL(request.url);
  const allowed = allowedHosts();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? "";
  const hostHeader = request.headers.get("host")?.trim() ?? "";
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() ?? "";
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : "";

  for (const candidate of [forwardedHost, hostHeader]) {
    if (!candidate || /[\s/@\\]/.test(candidate)) continue;
    const name = hostnameOf(candidate);
    if (!name || !allowed.has(name)) continue;
    const scheme = proto || (isLocalHost(name) ? requestUrl.protocol.replace(":", "") : "https");
    if (scheme !== "http" && scheme !== "https") continue;
    return `${scheme}://${candidate}`;
  }
  return requestUrl.origin;
}

export function publicHost(request: Request): string {
  return new URL(resolvePublicOrigin(request)).host;
}

/**
 * Absolute when the public host is known. Relative when a proxy header was present but the only
 * allowed host left is the internal bind address, so the browser stays on the site it requested.
 */
export function redirectLocation(request: Request, path: string): string {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const origin = resolvePublicOrigin(request);
  const hostname = new URL(origin).hostname.toLowerCase();
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? "";
  const forwardedName = forwarded ? hostnameOf(forwarded) : "";
  if (isLocalHost(hostname) && forwardedName && forwardedName !== hostname) return safePath;
  return new URL(safePath, `${origin}/`).toString();
}
