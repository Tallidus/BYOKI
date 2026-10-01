/** Public demo defaults. Mock mode and the memory store stay on unless an operator opts out. */
export function isMockMode(): boolean {
  const value = process.env.BYOKI_USE_MOCK;
  if (value === undefined || value.trim() === "") return true;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  throw new Error("BYOKI_USE_MOCK must be 1 or 0.");
}

export function storeMode(): "memory" | "file" {
  const value = process.env.BYOKI_STORE?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "memory") return "memory";
  if (value === "file") return "file";
  throw new Error("BYOKI_STORE must be memory or file.");
}

export const DEFAULT_PUBLIC_ORIGIN = "https://byoki.eastonnielson.dev";

export function publicSiteOrigin(): string {
  const value = process.env.BYOKI_PUBLIC_ORIGIN?.trim();
  if (!value) return DEFAULT_PUBLIC_ORIGIN;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BYOKI_PUBLIC_ORIGIN must be an absolute http(s) origin.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("BYOKI_PUBLIC_ORIGIN must be an absolute http(s) origin.");
  }
  return url.origin;
}
