import { redirect } from "next/navigation";
import { getSession } from "../../lib/auth";
import { isMockMode, storeMode } from "../../lib/env";
import { activateVisitor } from "../../lib/services";
import { DemoApp } from "./demo-app";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Live demo",
  description: "Anonymous BYOKI demo. Add a provider key for this browser only, then send a request in mock mode.",
};

export default async function DemoPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/api/session?next=/demo");
  await activateVisitor(session, session.exp);
  const query = await searchParams;
  const minutesLeft = Math.max(1, Math.round((session.exp - Date.now()) / 60_000));
  return (
    <main className="wrap">
      <p className="kicker">Interactive demo</p>
      <h1>The end-user flow, on a session that is only yours.</h1>
      <p className="lede">
        Connect a provider, pick a model, then send a prompt. Nothing on this page is shared with the next visitor.
      </p>
      <div className="section">
        <DemoApp
          csrfToken={session.csrf}
          expiresLabel={new Date(session.exp).toISOString().replace(".000Z", "Z")}
          minutesLeft={minutesLeft}
          mockMode={isMockMode()}
          storeMode={storeMode()}
          sessionLabel={session.userId.slice(2, 10)}
          csrfError={query.error === "csrf"}
        />
      </div>
    </main>
  );
}
