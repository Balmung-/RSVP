import { createHash, timingSafeEqual } from "node:crypto";

// Constant-time bearer-token comparison with no length oracle.
//
// `timingSafeEqual` requires equal-length buffers, so a naive
//   if (a.length !== b.length) return false
//   timingSafeEqual(a, b)
// leaks the secret length via timing. We instead hash both sides to
// a fixed 32-byte SHA-256 digest first — the length check then always
// succeeds and the actual comparison is on fixed-size inputs.
//
// Use for shared-bearer auth (inbound webhooks, cron tick). For HMAC
// signatures where both sides are already fixed-length hex, a direct
// timingSafeEqual is fine.
export function secretMatches(sent: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(sent).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
