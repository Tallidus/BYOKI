import { cookies } from "next/headers";
import { readSessionToken, type Session } from "./session";

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  return readSessionToken(jar.get("byoki_session")?.value);
}
