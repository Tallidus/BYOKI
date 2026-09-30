import { redirect } from "next/navigation";
import { getSession } from "../lib/auth";
import { DEMO_USERS } from "../lib/session";

export default async function HomePage() {
  const session = await getSession();
  if (session) redirect("/settings");
  return (
    <main>
      <h1>Garage Assistant</h1>
      <p>This reference app signs in two local users so you can see that connections stay on the user who created them.</p>
      <form className="login" action="/api/session" method="post">
        <label htmlFor="user">User</label>
        <select id="user" name="userId" defaultValue="user-a">
          {DEMO_USERS.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
        </select>
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" />
        <button type="submit">Sign in</button>
      </form>
      <p>Alice / alice, Bob / bob. These passwords exist only for this local demo.</p>
    </main>
  );
}
