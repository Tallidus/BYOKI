export type RateLimiter = {
  take(key: string): boolean;
};

export function createRateLimiter(limit: number, windowMs: number, now = () => Date.now()): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    take(key: string) {
      const stamp = now();
      const recent = (hits.get(key) ?? []).filter((time) => stamp - time < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(stamp);
      hits.set(key, recent);
      return true;
    },
  };
}
