import { test } from "node:test";
import assert from "node:assert/strict";

// Pins the fail-open + idempotency contract of revokeGoogleToken in
// `src/lib/oauth/google.ts`. The disconnect route relies on these
// guarantees:
//
//   1. NEVER throws — every error path returns a structured result.
//      If this broke, a Google 5xx would crash the disconnect handler
//      instead of falling through to local-row cleanup.
//
//   2. 400 invalid_token is treated as success (alreadyInvalid=true).
//      Admins double-clicking Disconnect shouldn't see a spurious
//      error on the second click; remote state is already "revoked"
//      and that's what we wanted.
//
//   3. Other non-2xx bodies return ok=false with the body preserved
//      for audit.
//
// All tests inject a stub fetch — zero network calls. Matches the
// existing oauth-url-builder / gmail-token-refresh test style.

const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

function makeFetch(
  responses: Array<
    | { status: number; body: string }
    | { throws: Error }
  >,
  calls: Array<{ url: string; init: unknown }>,
) {
  return async (url: string, init?: unknown) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("unexpected extra fetch call");
    if ("throws" in r) throw r.throws;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        try {
          return JSON.parse(r.body);
        } catch {
          return {};
        }
      },
      text: async () => r.body,
    };
  };
}

test("revokeGoogleToken: 200 response returns ok=true", async () => {
  const { revokeGoogleToken } = await import("../../src/lib/oauth/google");
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch([{ status: 200, body: "" }], calls);

  const r = await revokeGoogleToken({ token: "ya29.x", fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.alreadyInvalid, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REVOKE_URL);
});

test("revokeGoogleToken: POSTs token as form-encoded body", async () => {
  const { revokeGoogleToken } = await import("../../src/lib/oauth/google");
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch([{ status: 200, body: "" }], calls);

  await revokeGoogleToken({ token: "1//some-refresh-token", fetchImpl });
  const init = calls[0].init as {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  assert.equal(init.method, "POST");
  assert.equal(
    init.headers?.["content-type"],
    "application/x-www-form-urlencoded",
  );
  // The token must be form-encoded, not JSON. Using URLSearchParams
  // means slashes get percent-encoded — verify the helper round-trips
  // our token correctly.
  assert.equal(init.body, "token=1%2F%2Fsome-refresh-token");
});

test("revokeGoogleToken: 400 invalid_token is treated as success (alreadyInvalid)", async () => {
  // Critical idempotency contract — if this test breaks, an admin
  // clicking Disconnect twice on a stale row would see a spurious
  // "revoke failed" warning even though the end state is correct.
  const { revokeGoogleToken } = await import("../../src/lib/oauth/google");
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch(
    [{ status: 400, body: '{"error":"invalid_token"}' }],
    calls,
  );

  const r = await revokeGoogleToken({ token: "ya29.expired", fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.status, 400);
  assert.equal(r.alreadyInvalid, true);
});

test("revokeGoogleToken: 400 with other error returns ok=false", async () => {
  const { revokeGoogleToken } = await import("../../src/lib/oauth/google");
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch(
    [{ status: 400, body: '{"error":"malformed_request"}' }],
    calls,
  );

  const r = await revokeGoogleToken({ token: "ya29.x", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.alreadyInvalid, false);
  assert.ok(r.error?.includes("malformed_request"));
});

test("revokeGoogleToken: 503 returns ok=false with status + body", async () => {
  // Disconnect route uses this to surface a specific "remote_503"
  // warning while still dropping the local row.
  const { revokeGoogleToken } = await import("../../src/lib/oauth/google");
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch(
    [{ status: 503, body: "Service Unavailable" }],
    calls,
  );

  const r = await revokeGoogleToken({ token: "ya29.x", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.alreadyInvalid, false);
  assert.ok(r.error?.includes("Service Unavailable"));
});

test("revokeGoogleToken: network failure returns ok=false with status=0 (does NOT throw)", async () => {
  // The fail-open contract. If this test breaks, a transient DNS/TLS
  // failure would crash the disconnect handler instead of letting
  // the route continue to local-row cleanup.
  const { revokeGoogleToken } = await import("../../src/lib/oauth/google");
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch(
    [{ throws: new Error("ECONNREFUSED") }],
    calls,
  );

  const r = await revokeGoogleToken({ token: "ya29.x", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.equal(r.alreadyInvalid, false);
  assert.ok(r.error?.includes("ECONNREFUSED"));
});

test("revokeGoogleToken: accepts refresh tokens with special characters", async () => {
  // Google's refresh tokens start with `1//` and can contain / + =
  // characters that would break a naive string concat. URLSearchParams
  // handles encoding; this test guards against a future refactor
  // dropping the encoding.
  const { revokeGoogleToken } = await import("../../src/lib/oauth/google");
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = makeFetch([{ status: 200, body: "" }], calls);

  await revokeGoogleToken({
    token: "1//0abc+def/ghi=jkl",
    fetchImpl,
  });
  const init = calls[0].init as { body?: string };
  // `/` -> `%2F`, `+` -> `%2B`, `=` -> `%3D`
  assert.equal(
    init.body,
    "token=1%2F%2F0abc%2Bdef%2Fghi%3Djkl",
  );
});
