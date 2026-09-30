import { publicHost } from "./http";
import type { Session } from "./session";

export function originRejected(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== publicHost(request);
  } catch {
    return true;
  }
}

export function csrfRejected(request: Request, session: Session): boolean {
  return request.headers.get("x-csrf-token") !== session.csrf;
}

export function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}
