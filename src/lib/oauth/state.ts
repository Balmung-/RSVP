import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// HMAC-signed OAuth `state` tokens. Protects the redirect round-trip
// from CSRF and from tampered callbacks:
//   - Attacker crafts a URL that hits our `/callback` with their own
//     Google auth code. Without signed state, we'd process it and
//     connect THEIR Gmail to OUR team record — a classic "connect
//     confused" CSRF. With signed state, the callback checks the
//     HMAC and rejects any state we didn't issue.
//   - Attacker intercepts a real /start's state param and resubmits
//     an hour later. We reject on age. (Replay of an identical
//     callback is also harmless in practice because Google single-
//     uses auth codes, but age-rejection is cheap belt-and-suspenders.)
//
// We intentionally DO NOT store state nonces in Postgres or Redis.
// The HMAC + timestamp is enough: no storage state, no cleanup job,
// no race between issuing and verifying. Single-use is enforced by
// Google itself (auth codes are single-use).
//
// Format — `v1.<payload>.<hmac>`, all base64url-unpadded:
//   payload = base64url(JSON({ n: nonce, t: teamIdOrEmpty, ts: ms }))
//   hmac    = base64url(HMAC-SHA256(payload, SESSION_SECRET))
//
// Why SESSION_SECRET and not a distinct key:
//   Unlike OAUTH_ENCRYPTION_KEY (which MUST be separate — see
//   secrets.ts), the state HMAC is a short-lived signature. If
//   SESSION_SECRET leaks, the attacker can already forge login
//   cookies, which subsumes "can forge OAuth state". No additional
//   damage class, so reusing the secret keeps operator config simple.

const VERSION = "v1";
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — ample for a human click-through

export interface StatePayload {
  // Random nonce. Not strictly required for the HMAC to do its job
  // (the timestamp already keeps each state unique) but defence in
  // depth: if SESSION_SECRET ever leaked and was rotated, any stale
  // attacker-forged state would still fail on age AND nonce-binding
  // when paired with a start-side cookie check (callers may add one).
  nonce: string;
  // Target team for this connection. Empty string = office-wide
  // connection (no team binding). We sign it into the state so the
  // callback can't be tricked into binding the tokens to a different
  // team than the start request intended.
  teamId: string;
  // Issued-at (ms since epoch). Used to reject stale states.
  issuedAt: number;
}

function resolveSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) {
    throw new Error(
      "SESSION_SECRET is not set; required for OAuth state signing",
    );
  }
  return s;
}

function b64u(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64uDecode(s: string): Buffer {
  const pad = s.length % 4;
  const padded = pad === 0 ? s : s + "=".repeat(4 - pad);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Build a signed state token. `now` is injectable for tests — prod
// calls with the default and gets Date.now().
export function signState(
  input: { teamId: string | null | undefined },
  opts: { now?: number } = {},
): { state: string; nonce: string } {
  const nonce = b64u(randomBytes(16));
  const payload: StatePayload = {
    nonce,
    teamId: input.teamId ?? "",
    issuedAt: opts.now ?? Date.now(),
  };
  const payloadB64 = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = createHmac("sha256", resolveSecret())
    .update(`${VERSION}.${payloadB64}`)
    .digest();
  return {
    state: `${VERSION}.${payloadB64}.${b64u(mac)}`,
    nonce,
  };
}

export interface VerifyStateResult {
  ok: true;
  payload: StatePayload;
}
export interface VerifyStateError {
  ok: false;
  reason:
    | "malformed"
    | "version"
    | "signature"
    | "payload"
    | "expired"
    | "future"; // clock skew / client tampering
}

// Verify a state token. Returns a discriminated result rather than
// throwing because the route handler wants to audit the REASON for
// rejection (`oauth.google.denied` vs `oauth.google.error`) and an
// untyped Error makes that ugly.
export function verifyState(
  state: string,
  opts: { now?: number; maxAgeMs?: number } = {},
): VerifyStateResult | VerifyStateError {
  if (typeof state !== "string" || state.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const parts = state.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed" };
  }
  const [version, payloadB64, macB64] = parts;
  if (version !== VERSION) {
    return { ok: false, reason: "version" };
  }
  // Recompute MAC and compare in constant time.
  const expected = createHmac("sha256", resolveSecret())
    .update(`${VERSION}.${payloadB64}`)
    .digest();
  let actual: Buffer;
  try {
    actual = b64uDecode(macB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (actual.length !== expected.length) {
    return { ok: false, reason: "signature" };
  }
  if (!timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "signature" };
  }
  // Signature valid — now parse and age-check the payload.
  let payload: unknown;
  try {
    payload = JSON.parse(b64uDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "payload" };
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as StatePayload).nonce !== "string" ||
    typeof (payload as StatePayload).teamId !== "string" ||
    typeof (payload as StatePayload).issuedAt !== "number"
  ) {
    return { ok: false, reason: "payload" };
  }
  const p = payload as StatePayload;
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? MAX_AGE_MS;
  const age = now - p.issuedAt;
  if (age > maxAge) {
    return { ok: false, reason: "expired" };
  }
  // Negative age (future-dated) = client tampering or pathological
  // clock skew. Reject — a legitimate state never has this property.
  if (age < -5000) {
    return { ok: false, reason: "future" };
  }
  return { ok: true, payload: p };
}
