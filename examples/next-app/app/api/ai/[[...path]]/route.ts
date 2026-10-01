import { getSession } from "../../../../lib/auth";
import { publicHost } from "../../../../lib/http";
import { activateVisitor, getServices } from "../../../../lib/services";

export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const session = await getSession();
  if (session) await activateVisitor(session, session.exp);
  return getServices().handlers.dispatch(request, {
    scope: session ? { tenantId: session.tenantId, userId: session.userId } : null,
    csrfHeader: request.headers.get("x-csrf-token"),
    expectedCsrf: session?.csrf ?? null,
    origin: request.headers.get("origin"),
    host: publicHost(request),
  });
}

export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;
