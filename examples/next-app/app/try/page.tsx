import { redirect } from "next/navigation";
import { getSession } from "../../lib/auth";
import { TryForm } from "./try-form";

export default async function TryPage() {
  const session = await getSession();
  if (!session) redirect("/");
  return (
    <main>
      <nav>
        <a href="/settings">Settings</a>
        <a href="/try">Try a request</a>
      </nav>
      <h1>Try a request</h1>
      <TryForm csrfToken={session.csrf} />
    </main>
  );
}
