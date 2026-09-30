import { redirect } from "next/navigation";
import { getSession } from "../../lib/auth";
import { SettingsScreen } from "./settings-screen";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/");
  return (
    <main>
      <nav>
        <a href="/settings">Settings</a>
        <a href="/try">Try a request</a>
        <form action="/api/session" method="post">
          <input type="hidden" name="intent" value="logout" />
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <SettingsScreen csrfToken={session.csrf} />
    </main>
  );
}
