// Per-key token bucket. In-memory — resets on deploy. Good enough for a single
// replica behind Railway; for multi-replica, swap the Map for Redis.
// This is a floor, not a ceiling — pair with Cloudflare rate rules in front.

type Bucket = { tokens: number; last: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(
  key: string,
  { capacity = 10, refillPerSec = 0.5 }: { capacity?: number; refillPerSec?: number } = {},
): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: capacity, last: now };
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / refillPerSec) * 1000 };
  }
  b.tokens -= 1;
  buckets.set(key, b);
  // Keep the map bounded.
  if (buckets.size > 5000) {
    const cutoff = now - 60_000;
    for (const [k, v] of buckets) if (v.last < cutoff) buckets.delete(k);
  }
  return { ok: true, retryAfterMs: 0 };
}
