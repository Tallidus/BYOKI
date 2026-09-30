import { AIConnectionsError, isAIConnectionsError, type Capability } from "@byoki/core";
import { getSession } from "../../../../lib/auth";
import { getServices } from "../../../../lib/services";

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  const url = new URL(request.url);
  if (!session) {
    return Response.json({ ok: false, error: { code: "UNAUTHENTICATED", message: "Sign in first." } }, { status: 401 });
  }
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) {
    return Response.json({ ok: false, error: { code: "CSRF_FAILED", message: "The request origin was rejected." } }, { status: 401 });
  }
  if (request.headers.get("x-csrf-token") !== session.csrf) {
    return Response.json({ ok: false, error: { code: "CSRF_FAILED", message: "The security token did not match." } }, { status: 401 });
  }
  try {
    const body = (await request.json()) as { capability?: Capability; input?: unknown };
    if (body.capability !== "chat" && body.capability !== "vision") {
      throw new AIConnectionsError("INVALID_CONFIG", "Choose chat or vision.");
    }
    if (!Array.isArray(body.input)) {
      throw new AIConnectionsError("INVALID_CONFIG", "Include a message.");
    }
    const result = await getServices().router.forScope({ tenantId: session.tenantId, userId: session.userId }).invoke({
      capability: body.capability,
      input: body.input,
    });
    return Response.json({ ok: true, data: result });
  } catch (error) {
    const mapped = isAIConnectionsError(error)
      ? error
      : new AIConnectionsError("UPSTREAM_UNAVAILABLE", "The request failed.");
    const status = mapped.code === "CREDENTIAL_MISSING" || mapped.code === "MODEL_UNAVAILABLE" ? 404 : 400;
    return Response.json({ ok: false, error: { code: mapped.code, message: mapped.message } }, { status });
  }
}
