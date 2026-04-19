import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// Pins the AES-256-GCM envelope contract in `src/lib/secrets.ts`.
//
// What we're actually guarding:
//   (1) Round-trip correctness — whatever we encrypt we can decrypt
//       back to the exact same UTF-8 string. If this breaks, every
//       stored Gmail refresh token becomes unusable on next read and
//       every connected mailbox silently stops sending.
//   (2) Non-determinism — two encrypts of the same plaintext must
//       produce different envelopes (fresh IV per call). A
//       deterministic output would leak "these two rows hold the
//       same token" via ciphertext equality across accounts.
//   (3) Tamper-evidence — GCM must reject any single-bit flip in the
//       ciphertext, IV, or auth tag. A silent "garbled plaintext"
//       decode would be catastrophic (we'd feed garbage as an OAuth
//       token and Google would 401 with no diagnostic).
//   (4) Cross-envelope substitution resistance — two envelopes
//       encrypted under the same key are not interchangeable. A row
//       swap at the DB layer should surface as an auth failure, not
//       as "accidentally decrypted someone else's token".
//   (5) Wrong-key failure — if OAUTH_ENCRYPTION_KEY rotates without
//       running a re-encrypt migration, old envelopes must throw
//       rather than decrypt to garbage. Same GCM path as (3).
//   (6) Envelope version guard — a `v2.` prefix from a future
//       rotation scheme must not be silently accepted by the `v1`
//       decrypter.
//   (7) Envelope structural guards — wrong part count, non-base64
//       fields, wrong IV/tag lengths all throw rather than being
//       leniently repaired.
//
// These are ALL covered below in a single process by setting
// OAUTH_ENCRYPTION_KEY at test start and using module-level state —
// keeping the test harness zero-fixture. The `secrets` module reads
// the env var lazily at every encrypt/decrypt call, so mutating
// process.env mid-test is fine and each test is independent.

function setKey(bytes: number = 32): string {
  const key = randomBytes(bytes).toString("base64");
  process.env.OAUTH_ENCRYPTION_KEY = key;
  return key;
}

test("encryptSecret/decryptSecret round-trips a UTF-8 string", async () => {
  setKey();
  const { encryptSecret, decryptSecret } = await import("../../src/lib/secrets");
  const plain = "ya29.A0ARrdaM-example-access-token-with-nonalphanumerics:+/=";
  const env = encryptSecret(plain);
  const out = decryptSecret(env);
  assert.equal(out, plain);
});

test("encryptSecret produces a distinct envelope per call (fresh IV)", async () => {
  setKey();
  const { encryptSecret, decryptSecret } = await import("../../src/lib/secrets");
  const plain = "same plaintext twice";
  const a = encryptSecret(plain);
  const b = encryptSecret(plain);
  assert.notEqual(a, b, "two encrypts of the same plaintext must differ");
  // Both must still decrypt back to the same plaintext.
  assert.equal(decryptSecret(a), plain);
  assert.equal(decryptSecret(b), plain);
});

test("envelope format is v1.<iv>.<tag>.<ct> — 4 dot-separated parts", async () => {
  setKey();
  const { encryptSecret } = await import("../../src/lib/secrets");
  const env = encryptSecret("payload");
  const parts = env.split(".");
  assert.equal(parts.length, 4, "envelope must have 4 parts");
  assert.equal(parts[0], "v1");
  // Remaining three parts must be non-empty base64url (no padding).
  for (const p of parts.slice(1)) {
    assert.ok(p.length > 0, "envelope field must be non-empty");
    assert.ok(
      /^[A-Za-z0-9_-]+$/.test(p),
      `envelope field must be base64url-unpadded; got "${p}"`,
    );
  }
});

test("decryptSecret rejects a tampered ciphertext (GCM auth failure)", async () => {
  setKey();
  const { encryptSecret, decryptSecret } = await import("../../src/lib/secrets");
  const env = encryptSecret("secret");
  const parts = env.split(".");
  // Flip the first character of the ciphertext. Any single-bit change
  // must fail GCM auth.
  const ct = parts[3];
  const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
  const tampered = [parts[0], parts[1], parts[2], flipped].join(".");
  assert.throws(() => decryptSecret(tampered), /authentication failed/);
});

test("decryptSecret rejects a tampered IV", async () => {
  setKey();
  const { encryptSecret, decryptSecret } = await import("../../src/lib/secrets");
  const env = encryptSecret("secret");
  const parts = env.split(".");
  const iv = parts[1];
  const flipped = (iv[0] === "A" ? "B" : "A") + iv.slice(1);
  const tampered = [parts[0], flipped, parts[2], parts[3]].join(".");
  assert.throws(() => decryptSecret(tampered), /authentication failed/);
});

test("decryptSecret rejects a tampered auth tag", async () => {
  setKey();
  const { encryptSecret, decryptSecret } = await import("../../src/lib/secrets");
  const env = encryptSecret("secret");
  const parts = env.split(".");
  const tag = parts[2];
  const flipped = (tag[0] === "A" ? "B" : "A") + tag.slice(1);
  const tampered = [parts[0], parts[1], flipped, parts[3]].join(".");
  assert.throws(() => decryptSecret(tampered), /authentication failed/);
});

test("decryptSecret rejects cross-envelope substitution under same key", async () => {
  setKey();
  const { encryptSecret, decryptSecret } = await import("../../src/lib/secrets");
  const a = encryptSecret("token-for-account-A").split(".");
  const b = encryptSecret("token-for-account-B").split(".");
  // Take A's IV+tag but B's ciphertext. GCM authenticates ct under
  // (key, iv), so this Frankenstein envelope must fail.
  const franken = [a[0], a[1], a[2], b[3]].join(".");
  assert.throws(() => decryptSecret(franken), /authentication failed/);
});

test("decryptSecret rejects an envelope encrypted under a different key", async () => {
  setKey();
  const { encryptSecret } = await import("../../src/lib/secrets");
  const env = encryptSecret("cross-key payload");
  // Rotate the key WITHOUT a re-encrypt migration. Old envelope must
  // fail — never silently decode.
  setKey();
  const { decryptSecret } = await import("../../src/lib/secrets");
  assert.throws(() => decryptSecret(env), /authentication failed/);
});

test("decryptSecret rejects unknown version prefix", async () => {
  setKey();
  const { encryptSecret, decryptSecret } = await import("../../src/lib/secrets");
  const env = encryptSecret("payload");
  const parts = env.split(".");
  const future = ["v2", parts[1], parts[2], parts[3]].join(".");
  assert.throws(() => decryptSecret(future), /unsupported envelope version/);
});

test("decryptSecret rejects malformed envelopes (wrong part count)", async () => {
  setKey();
  const { decryptSecret } = await import("../../src/lib/secrets");
  assert.throws(() => decryptSecret("only.three.parts"), /malformed envelope/);
  assert.throws(
    () => decryptSecret("v1.a.b.c.extra"),
    /malformed envelope/,
  );
  assert.throws(() => decryptSecret(""), /malformed envelope/);
});

test("decryptSecret rejects wrong IV length", async () => {
  setKey();
  const { encryptSecret, decryptSecret } = await import("../../src/lib/secrets");
  const env = encryptSecret("payload");
  const parts = env.split(".");
  // Truncate the IV by a few chars — still valid base64url, but
  // decodes to fewer than 12 bytes.
  const shortIv = parts[1].slice(0, parts[1].length - 4);
  const broken = [parts[0], shortIv, parts[2], parts[3]].join(".");
  assert.throws(() => decryptSecret(broken), /IV length mismatch/);
});

test("decryptSecret rejects wrong tag length", async () => {
  setKey();
  const { encryptSecret, decryptSecret } = await import("../../src/lib/secrets");
  const env = encryptSecret("payload");
  const parts = env.split(".");
  const shortTag = parts[2].slice(0, parts[2].length - 4);
  const broken = [parts[0], parts[1], shortTag, parts[3]].join(".");
  assert.throws(() => decryptSecret(broken), /auth tag length mismatch/);
});

test("encryptSecret throws when OAUTH_ENCRYPTION_KEY is unset", async () => {
  delete process.env.OAUTH_ENCRYPTION_KEY;
  const { encryptSecret } = await import("../../src/lib/secrets");
  assert.throws(() => encryptSecret("x"), /OAUTH_ENCRYPTION_KEY is not set/);
});

test("encryptSecret throws when OAUTH_ENCRYPTION_KEY is wrong length", async () => {
  // 16-byte key, base64-encoded. Must be rejected — AES-256 requires
  // 32 bytes.
  process.env.OAUTH_ENCRYPTION_KEY = randomBytes(16).toString("base64");
  const { encryptSecret } = await import("../../src/lib/secrets");
  assert.throws(() => encryptSecret("x"), /must decode to exactly 32 bytes/);
});

test("envelopesEqual returns true for identical strings, false for any difference", async () => {
  setKey();
  const { encryptSecret, envelopesEqual } = await import("../../src/lib/secrets");
  const env = encryptSecret("a");
  assert.equal(envelopesEqual(env, env), true);
  const other = encryptSecret("a");
  assert.equal(envelopesEqual(env, other), false, "fresh IV makes envelopes unequal");
  assert.equal(envelopesEqual("x", "xx"), false, "different lengths");
});
