import {
  AIConnectionsError,
  UPSTREAM_ERROR_MESSAGES,
  isAIConnectionsError,
  messageForVisitor,
  type Capability,
} from "@byoki/core";
import { getSession } from "../../../../lib/auth";
import { csrfRejected, jsonError, originRejected } from "../../../../lib/guard";
import { activateVisitor, getServices } from "../../../../lib/services";

export const dynamic = "force-dynamic";

const MAX_BODY = 200_000;

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return jsonError("UNAUTHENTICATED", "Start a demo session first.", 401);
  if (originRejected(request) || csrfRejected(request, session)) {
    return jsonError("CSRF_FAILED", "The security token did not match.", 401);
  }
  await activateVisitor(session, session.exp);
  try {
    const declared = request.headers.get("content-length");
    if (declared && Number(declared) > MAX_BODY) {
      return jsonError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413);
    }
    const text = await request.text();
    if (text.length > MAX_BODY) return jsonError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413);
    const body = JSON.parse(text) as { capability?: Capability; input?: unknown };
    if (body.capability !== "chat" && body.capability !== "vision") {
      throw new AIConnectionsError("INVALID_CONFIG", "Choose chat or vision.");
    }
    if (!Array.isArray(body.input)) {
      throw new AIConnectionsError("INVALID_CONFIG", "Include a message.");
    }
    const result = await getServices()
      .router.forScope({ tenantId: session.tenantId, userId: session.userId })
      .invoke({
        capability: body.capability,
        input: body.input,
      });
    return Response.json({ ok: true, data: result });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonError("INVALID_CONFIG", "Request body must be JSON.", 400);
    }
    const mapped = isAIConnectionsError(error)
      ? error
      : new AIConnectionsError("UPSTREAM_UNAVAILABLE", UPSTREAM_ERROR_MESSAGES.unknown);
    const status = mapped.code === "CREDENTIAL_MISSING" || mapped.code === "MODEL_UNAVAILABLE" ? 404 : 400;
    return jsonError(mapped.code, messageForVisitor(mapped), status);
  }
}
