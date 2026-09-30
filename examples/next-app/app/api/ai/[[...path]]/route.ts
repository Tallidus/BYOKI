import { getSession } from "../../../../lib/auth";
import { getServices } from "../../../../lib/services";

async function handle(request: Request): Promise<Response> {
  const session = await getSession();
  const url = new URL(request.url);
  return getServices().handlers.dispatch(request, {
    scope: session ? { tenantId: session.tenantId, userId: session.userId } : null,
    csrfHeader: request.headers.get("x-csrf-token"),
    expectedCsrf: session?.csrf ?? null,
    origin: request.headers.get("origin"),
    host: url.host,
  });
}

export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;
