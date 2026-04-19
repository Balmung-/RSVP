import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// At-rest encryption for credentials that must live in Postgres rather
// than in env vars (Phase B1: Gmail OAuth access + refresh tokens).
// API-key-in-.env remains the right pattern for provider-level secrets
// (SendGrid / Resend / Twilio) — this module is specifically for
// PER-ACCOUNT credentials where "just put it in .env" doesn't scale
// past one Gmail mailbox.
//
// Algorithm choice — AES-256-GCM:
//   - Authenticated (tamper-evident). A truncated or swapped ciphertext
//     is rejected by decrypt() rather than silently producing garbage.
//   - 12-byte IV is the standard GCM nonce; 16-byte authTag is fixed.
//   - Deterministic-across-runs only if IV is reused — which we never
//     do. Each encrypt call generates a fresh IV via randomBytes.
//   - node:crypto native, no dep on a userland libsodium / jose shim.
//
// Envelope format — `v1.<iv>.<authTag>.<ciphertext>`:
//   - Version prefix reserves room for a future key-rotation scheme
//     (`v2` could, e.g., include a key-id and try each key on read).
//     Present decrypt() only accepts `v1`; unknown versions throw.
//   - Four dot-separated base64url-unpadded components. Dot is safe
//     because base64url doesn't use it. We don't need padding because
//     all three trailing fields have known fixed or self-describing
//     lengths (GCM authTag is always 16 bytes, IV is always 12).
//
// Key provisioning — `OAUTH_ENCRYPTION_KEY`:
//   - 32 raw bytes, base64-encoded. Generate with `openssl rand -base64
//     32` and drop into .env / your secrets manager.
//   - Distinct from SESSION_SECRET on purpose. SESSION_SECRET is used
//     for HMAC over session cookies; if it leaked, the attacker could
//     forge a login cookie for any user, which is bad but recoverable
//     (rotate the secret, invalidate all sessions). If
//     OAUTH_ENCRYPTION_KEY leaked, the attacker could decrypt every
//     stored access+refresh token in the DB — a *compounding* breach
//     (one compromised copy of the .env lets them impersonate every
//     connected Gmail mailbox until each one is individually
//     revoked). Keeping them separate means one leak doesn't unlock
//     the other class.
//   - Rotation: once we need it, bump `v1` -> `v2` in this file,
//     teach decrypt() to try the current key first and an
//     OAUTH_ENCRYPTION_KEY_PREV as a fallback, and run a background
//     job to re-encrypt rows as they're read. Documented here so the
//     future-me doesn't invent a new scheme.
//
// This module is TEST-ABLE AS-IS via `node:test` — no Prisma, no
// network, no external services. See
// `tests/unit/secrets-roundtrip.test.ts`.

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// Lazy key resolution so import doesn't blow up a test harness or a
// cold start that legitimately hasn't set the env var yet (e.g. a
// route that isn't in the OAuth path). Every encrypt/decrypt call
// forces resolution — if the env var is missing or malformed at the
// moment it's actually needed, we throw with a clear error rather
// than silently writing plaintext or reading garbage.
function resolveKey(): Buffer {
  const raw = process.env.OAUTH_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "OAUTH_ENCRYPTION_KEY is not set. Generate with `openssl rand -base64 32` and add to .env.",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("OAUTH_ENCRYPTION_KEY is not valid base64.");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `OAUTH_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (AES-256 key); got ${key.length}.`,
    );
  }
  return key;
}

// base64url without padding. Dot-delimited envelope stays URL-safe and
// copy-paste-safe; no characters that need escaping in JSON strings.
function b64u(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64uDecode(s: string): Buffer {
  // Restore padding so Node's base64 decoder accepts it. base64url and
  // base64 are otherwise identical byte-for-byte.
  const pad = s.length % 4;
  const padded = pad === 0 ? s : s + "=".repeat(4 - pad);
  return Buffer.from(
    padded.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
}

// Encrypt a UTF-8 string. Returns the envelope `v1.<iv>.<tag>.<ct>`.
// Each call uses a fresh 12-byte IV — the same plaintext encrypts to a
// different ciphertext every time, which is what we want for tokens
// (no ciphertext-equality correlation attacks across rows).
export function encryptSecret(plain: string): string {
  if (typeof plain !== "string") {
    throw new Error("encryptSecret: plaintext must be a string");
  }
  const key = resolveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${b64u(iv)}.${b64u(tag)}.${b64u(ct)}`;
}

// Decrypt an envelope previously produced by encryptSecret. Throws on
// any malformation (wrong version, bad base64, short IV/tag, or GCM
// auth failure). The GCM auth failure is the important one — a
// tampered ciphertext, a wrong key, or a swapped-in other-row's
// ciphertext all land here as "unsupported state or unable to
// authenticate data" from node:crypto, which we translate to a
// consistent error message.
export function decryptSecret(envelope: string): string {
  if (typeof envelope !== "string") {
    throw new Error("decryptSecret: envelope must be a string");
  }
  const parts = envelope.split(".");
  if (parts.length !== 4) {
    throw new Error("decryptSecret: malformed envelope (expected 4 parts)");
  }
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) {
    throw new Error(
      `decryptSecret: unsupported envelope version "${version}"; expected "${VERSION}"`,
    );
  }
  const iv = b64uDecode(ivB64);
  const tag = b64uDecode(tagB64);
  const ct = b64uDecode(ctB64);
  if (iv.length !== IV_BYTES) {
    throw new Error("decryptSecret: IV length mismatch");
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error("decryptSecret: auth tag length mismatch");
  }
  const key = resolveKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // Normalise the Node "unsupported state or unable to authenticate
    // data" error. Anything that lands here is a tamper / wrong-key /
    // corrupted-row situation; they're indistinguishable by design
    // (GCM on purpose doesn't leak which).
    throw new Error("decryptSecret: authentication failed");
  }
}

// Convenience helper for equality checks on envelopes — used rarely
// but keeps callers away from ad-hoc timing-unsafe string compares.
export function envelopesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
