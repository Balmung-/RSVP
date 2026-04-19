import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// Pins the token-freshness + refresh-and-persist contract in
// `src/lib/oauth/tokens.ts`. This is the subtle bit of B2 — a
// missed expiry = Google returns 401s; a double-refresh race is
// harmless; an `invalid_grant` means the user revoked and we must
// fail closed with a non-retryable error.
//
// Test strategy:
//   - Set OAUTH_ENCRYPTION_KEY up front so encrypt/decrypt round-
//     trip against a real key.
//   - Inject a stub FetchLike for the refresh endpoint — we control
//     what Google "says" response-by-response.
//   - Use `now` overrides to drive the staleness decision
//     deterministically.
//   - For onRefresh, pass a plain record-closure; no Prisma.

process.env.OAUTH_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const NOW = 1_700_000_000_000;

function makeFetch(
  responses: Array<{ status: number; body: unknown }>,
  calls: Array<{ url: string; init: unknown }>,
) {
  return async (url: string, init?: unknown) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("unexpected extra fetch call");
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
}

test("isStale returns false when expiry is comfortably in the future", async () => {
  const { isStale } = await import("../../src/lib/oauth/tokens");
  const expires = new Date(NOW + 30 * 60 * 1000); // 30 min out
  assert.equal(isStale(expires, { now: NOW }), false);
});

test("isStale returns true when expiry is within the default 60s skew", async () => {
  const { isStale } = await import("../../src/lib/oauth/tokens");
  const expires = new Date(NOW + 30 * 1000); // 30s out — under skew
  assert.equal(isStale(expires, { now: NOW }), true);
});

test("isStale returns true when already expired", async () => {
  const { isStale } = await import("../../src/lib/oauth/tokens");
  const expires = new Date(NOW - 60 * 1000);
  assert.equal(isStale(expires, { now: NOW }), true);
});

test("isStale honors custom skewMs", async () => {
  const { isStale } = await import("../../src/lib/oauth/tokens");
  // 10 min out, skew 15 min -> stale.
  assert.equal(
    isStale(new Date(NOW + 10 * 60_000), { now: NOW, skewMs: 15 * 60_000 }),
    true,
  );
  // 10 min out, skew 5 min -> fresh.
  assert.equal(
    isStale(new Date(NOW + 10 * 60_000), { now: NOW, skewMs: 5 * 60_000 }),
    false,
  );
});

test("getFreshAccessToken fast-path: fresh token decrypts and returns, no fetch call", async () => {
  const { encryptSecret } = await import("../../src/lib/secrets");
  const { getFreshAccessToken } = await import("../../src/lib/oauth/tokens");

  const access = "ya29.fresh-access-token";
  const refresh = "1//refresh-token";
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch([], calls); // no responses = any fetch call throws

  const r = await getFreshAccessToken({
    account: {
      id: "acc_1",
      accessTokenEnc: encryptSecret(access),
      refreshTokenEnc: encryptSecret(refresh),
      tokenExpiresAt: new Date(NOW + 30 * 60_000), // 30 min out
    },
    clientId: "cid",
    clientSecret: "csecret",
    fetchImpl,
    now: NOW,
  });

  assert.equal(r.accessToken, access);
  assert.equal(r.refreshed, false);
  assert.equal(calls.length, 0, "no fetch call on fresh path");
});

test("getFreshAccessToken stale-path: refreshes, re-encrypts, invokes onRefresh", async () => {
  const { encryptSecret, decryptSecret } = await import("../../src/lib/secrets");
  const { getFreshAccessToken } = await import("../../src/lib/oauth/tokens");

  const oldAccess = "ya29.old-access";
  const refreshTok = "1//refresh-token";
  const newAccess = "ya29.new-access";

  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch(
    [
      {
        status: 200,
        body: {
          access_token: newAccess,
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.send openid email",
          token_type: "Bearer",
        },
      },
    ],
    calls,
  );

  const persisted: Array<{
    accountId: string;
    accessTokenEnc: string;
    tokenExpiresAt: Date;
  }> = [];

  const r = await getFreshAccessToken({
    account: {
      id: "acc_1",
      accessTokenEnc: encryptSecret(oldAccess),
      refreshTokenEnc: encryptSecret(refreshTok),
      tokenExpiresAt: new Date(NOW - 5_000), // already expired
    },
    clientId: "cid",
    clientSecret: "csecret",
    fetchImpl,
    now: NOW,
    onRefresh: async (u) => {
      persisted.push(u);
    },
  });

  assert.equal(r.accessToken, newAccess);
  assert.equal(r.refreshed, true);
  assert.equal(calls.length, 1, "exactly one refresh call");
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");

  // The persisted ciphertext must decrypt back to the new access
  // token — otherwise the next send reads a token that doesn't
  // match what Google handed us.
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].accountId, "acc_1");
  assert.equal(decryptSecret(persisted[0].accessTokenEnc), newAccess);

  // New expiry must apply the 60s safety skew.
  assert.equal(
    persisted[0].tokenExpiresAt.getTime(),
    NOW + (3600 - 60) * 1000,
  );
});

test("getFreshAccessToken without onRefresh still returns the new token", async () => {
  const { encryptSecret } = await import("../../src/lib/secrets");
  const { getFreshAccessToken } = await import("../../src/lib/oauth/tokens");

  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch(
    [
      {
        status: 200,
        body: {
          access_token: "ya29.new",
          expires_in: 1800,
          scope: "x",
          token_type: "Bearer",
        },
      },
    ],
    calls,
  );

  const r = await getFreshAccessToken({
    account: {
      id: "acc_1",
      accessTokenEnc: encryptSecret("old"),
      refreshTokenEnc: encryptSecret("r"),
      tokenExpiresAt: new Date(NOW - 1000),
    },
    clientId: "cid",
    clientSecret: "cs",
    fetchImpl,
    now: NOW,
    // no onRefresh
  });

  assert.equal(r.accessToken, "ya29.new");
  assert.equal(r.refreshed, true);
  assert.ok(r.newAccessTokenEnc, "newAccessTokenEnc must be returned when refreshed");
  assert.ok(r.newTokenExpiresAt, "newTokenExpiresAt must be returned when refreshed");
});

test("getFreshAccessToken throws TokenRevokedError on invalid_grant", async () => {
  const { encryptSecret } = await import("../../src/lib/secrets");
  const { getFreshAccessToken, TokenRevokedError } = await import(
    "../../src/lib/oauth/tokens"
  );

  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch(
    [
      {
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        },
      },
    ],
    calls,
  );

  await assert.rejects(
    () =>
      getFreshAccessToken({
        account: {
          id: "acc_1",
          accessTokenEnc: encryptSecret("old"),
          refreshTokenEnc: encryptSecret("r"),
          tokenExpiresAt: new Date(NOW - 1000),
        },
        clientId: "cid",
        clientSecret: "cs",
        fetchImpl,
        now: NOW,
      }),
    (err: unknown) => {
      // Must be the named subclass, not a plain Error, so provider
      // `instanceof` checks work.
      assert.ok(
        err instanceof TokenRevokedError,
        `expected TokenRevokedError, got ${err}`,
      );
      return true;
    },
  );
});

test("getFreshAccessToken rethrows non-invalid_grant refresh errors as plain Error (retryable upstream)", async () => {
  const { encryptSecret } = await import("../../src/lib/secrets");
  const { getFreshAccessToken, TokenRevokedError } = await import(
    "../../src/lib/oauth/tokens"
  );

  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch(
    [
      {
        status: 503,
        body: {
          error: "backend_error",
          error_description: "The service is currently unavailable.",
        },
      },
    ],
    calls,
  );

  await assert.rejects(
    () =>
      getFreshAccessToken({
        account: {
          id: "acc_1",
          accessTokenEnc: encryptSecret("old"),
          refreshTokenEnc: encryptSecret("r"),
          tokenExpiresAt: new Date(NOW - 1000),
        },
        clientId: "cid",
        clientSecret: "cs",
        fetchImpl,
        now: NOW,
      }),
    (err: unknown) => {
      // NOT a TokenRevokedError — the provider must treat this as
      // retryable, unlike invalid_grant which is terminal.
      assert.ok(!(err instanceof TokenRevokedError));
      return true;
    },
  );
});
