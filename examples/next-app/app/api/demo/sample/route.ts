import { redact } from "@byoki/server";
import { getSession } from "../../../../lib/auth";
import { isMockMode } from "../../../../lib/env";
import { csrfRejected, jsonError, originRejected } from "../../../../lib/guard";
import { connectSample } from "../../../../lib/sample";
import { activateVisitor } from "../../../../lib/services";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return jsonError("UNAUTHENTICATED", "Start a demo session first.", 401);
  if (originRejected(request) || csrfRejected(request, session)) {
    return jsonError("CSRF_FAILED", "The security token did not match.", 401);
  }
  if (!isMockMode()) {
    return jsonError("INVALID_CONFIG", "Sample connections are only created while mock mode is on.", 400);
  }
  await activateVisitor(session, session.exp);
  try {
    await connectSample({ tenantId: session.tenantId, userId: session.userId });
    return Response.json({
      ok: true,
      data: { provider: "openai", modelId: "gpt-5.6-terra", capability: "chat" },
    });
  } catch (error) {
    const message = error instanceof Error ? redact(error.message) : "The sample connection could not be saved.";
    return jsonError("UPSTREAM_UNAVAILABLE", message, 400);
  }
}
