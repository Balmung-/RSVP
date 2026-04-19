import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAuthUrl,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_SCOPES,
} from "../../src/lib/oauth/google";

// Pins the Google OAuth authorize-URL contract. This is a pure
// string-building function but it's the ONE file where a scope
// widening could land unnoticed — a PR that adds ".readonly" or
// ".modify" would silently request more access than we need, and
// Google's consent screen would rubber-stamp it the next time an
// admin reconnects. The scope list test below is the guard: any
// change to GOOGLE_SCOPES requires editing this test, which forces
// a deliberate review.

test("buildAuthUrl points at Google's v2 authorize endpoint", () => {
  const url = buildAuthUrl({
    clientId: "cid",
    redirectUri: "https://example/callback",
    state: "s",
  });
  assert.ok(
    url.startsWith(GOOGLE_AUTHORIZE_URL + "?"),
    `expected url to start with ${GOOGLE_AUTHORIZE_URL}?, got ${url}`,
  );
});

test("buildAuthUrl requests exactly the minimum scopes (gmail.send + openid + email)", () => {
  const url = buildAuthUrl({
    clientId: "cid",
    redirectUri: "https://example/callback",
    state: "s",
  });
  const u = new URL(url);
  const scope = u.searchParams.get("scope");
  assert.ok(scope !== null);
  const parts = scope!.split(" ").sort();
  const expected = [...GOOGLE_SCOPES].sort();
  assert.deepEqual(parts, expected);
  // And explicitly assert the expected set — if a future PR adds a
  // scope, this test fails and forces a review.
  assert.deepEqual(parts, [
    "email",
    "https://www.googleapis.com/auth/gmail.send",
    "openid",
  ]);
});

test("buildAuthUrl sets access_type=offline and prompt=consent (refresh token required)", () => {
  const url = buildAuthUrl({
    clientId: "cid",
    redirectUri: "https://example/callback",
    state: "s",
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  // include_granted_scopes is a nice-to-have but we bake it in; keep
  // the assertion so a removal is deliberate.
  assert.equal(u.searchParams.get("include_granted_scopes"), "true");
});

test("buildAuthUrl threads through client_id, redirect_uri, state, response_type", () => {
  const url = buildAuthUrl({
    clientId: "my-client-id",
    redirectUri: "https://rsvp.gov.sa/api/oauth/google/callback",
    state: "v1.payload.mac",
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get("client_id"), "my-client-id");
  assert.equal(
    u.searchParams.get("redirect_uri"),
    "https://rsvp.gov.sa/api/oauth/google/callback",
  );
  assert.equal(u.searchParams.get("state"), "v1.payload.mac");
  assert.equal(u.searchParams.get("response_type"), "code");
});

test("buildAuthUrl emits login_hint only when provided", () => {
  const withHint = buildAuthUrl({
    clientId: "cid",
    redirectUri: "https://example/callback",
    state: "s",
    loginHint: "protocol@office.gov.sa",
  });
  const u1 = new URL(withHint);
  assert.equal(u1.searchParams.get("login_hint"), "protocol@office.gov.sa");

  const withoutHint = buildAuthUrl({
    clientId: "cid",
    redirectUri: "https://example/callback",
    state: "s",
  });
  const u2 = new URL(withoutHint);
  assert.equal(u2.searchParams.get("login_hint"), null);
});

test("buildAuthUrl rejects empty required inputs", () => {
  assert.throws(
    () =>
      buildAuthUrl({
        clientId: "",
        redirectUri: "https://example/callback",
        state: "s",
      }),
    /clientId required/,
  );
  assert.throws(
    () =>
      buildAuthUrl({
        clientId: "cid",
        redirectUri: "",
        state: "s",
      }),
    /redirectUri required/,
  );
  assert.throws(
    () =>
      buildAuthUrl({
        clientId: "cid",
        redirectUri: "https://example/callback",
        state: "",
      }),
    /state required/,
  );
});
