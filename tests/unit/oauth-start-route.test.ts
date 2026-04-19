import { test } from "node:test";
import assert from "node:assert/strict";
import type { User } from "@prisma/client";
import type { Role } from "../../src/lib/auth";
import {
  startHandler,
  NONCE_COOKIE,
  NONCE_COOKIE_MAX_AGE_S,
  type StartDeps,
  type StartEnv,
  type StartResult,
  type LogEntry,
  type CookieSpec,
} from "../../src/app/api/oauth/google/start/handler";

// Route-level tests for GET /api/oauth/google/start. They exercise the
// pure `startHandler` with stub deps so every branch maps cleanly to an
// operator-visible outcome:
//
//   - 401 unauthorized          -> no session cookie at all
//   - 403 forbidden             -> editor/viewer trying to connect Gmail
//   - 503 oauth_not_configured  -> one or more of the 4 OAuth env vars missing;
//                                  response must include a `hint` listing
//                                  the exact missing names so ops can fix
//                                  one round trip
//   - 303 invalid_team          -> ?teamId points at a deleted/bogus team;
//                                  must redirect to /settings with a
//                                  reason, NOT return 500
//   - 302 happy office-wide     -> no teamId -> signState({teamId: null}),
//                                  buildAuthUrl with exactly the 4 required
//                                  inputs, nonce cookie on the response
//   - 302 happy team-scoped     -> teamId provided and valid -> signed
//                                  state carries the teamId
//   - login-hint passthrough    -> ?hint=<email> forwards to buildAuthUrl
//   - NODE_ENV=production       -> nonce cookie gets secure=true
//
// Why this file exists: the route logic used to live inline in
// route.ts and was untestable without spinning up Next's RSC runtime
// + a real Prisma client + a Google OAuth client. Extracting a pure
// handler with injected deps means we can pin the admin gate and the
// CSRF cookie with plain assertions — GPT's B4 callout.

// --- Helpers -------------------------------------------------------

const FULL_ENV: StartEnv = {
  GOOGLE_OAUTH_CLIENT_ID: "client-id-xyz",
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret-xyz",
  GOOGLE_OAUTH_REDIRECT_URI: "https://app.example.gov/api/oauth/google/callback",
  OAUTH_ENCRYPTION_KEY: "enc-key-32-bytes-or-more-xxxxxxx",
  APP_BASE_URL: "https://app.example.gov",
  NODE_ENV: "test",
};

// Build a minimal Request with a URL — the handler calls
// `new URL(req.url)` to read searchParams so the URL must be valid.
function makeReq(search = ""): Request {
  return new Request(`https://app.example.gov/api/oauth/google/start${search}`);
}

// Minimal User shape the handler touches (only `.id`). Cast through
// unknown to skirt Prisma's full schema — the handler doesn't read
// the other fields and we don't want the test to know the DB model.
const ADMIN: User = { id: "user-admin-1" } as unknown as User;
const EDITOR: User = { id: "user-editor-1" } as unknown as User;

// Capture-style deps. Every dep records its calls so tests can
// assert both outcome AND that a short-circuit branch didn't make a
// wasted call (e.g. a 401 must not sign state).
function makeDeps(overrides: {
  user?: User | null;
  role?: Role;
  team?: { id: string } | null;
  env?: Partial<StartEnv>;
  signState?: (input: { teamId: string | null }) => { state: string; nonce: string };
  buildAuthUrl?: (input: {
    clientId: string;
    redirectUri: string;
    state: string;
    loginHint?: string;
  }) => string;
} = {}) {
  const logs: LogEntry[] = [];
  const findTeamCalls: string[] = [];
  const signCalls: Array<{ teamId: string | null }> = [];
  const buildCalls: Array<{
    clientId: string;
    redirectUri: string;
    state: string;
    loginHint?: string;
  }> = [];

  const user = overrides.user === undefined ? ADMIN : overrides.user;
  const role: Role = overrides.role ?? "admin";

  // Defaults for signState / buildAuthUrl if the test didn't override.
  // Kept as plain functions (no capture inside) so the capture-wrap
  // below pushes exactly once per call.
  const defaultSignState = (_input: { teamId: string | null }) => ({
    state: "signed-state-abc",
    nonce: "nonce-xyz",
  });
  const defaultBuildAuthUrl = (input: {
    clientId: string;
    redirectUri: string;
    state: string;
    loginHint?: string;
  }) => `https://accounts.google.com/oauth/authorize?state=${input.state}`;

  const innerSign = overrides.signState ?? defaultSignState;
  const innerBuild = overrides.buildAuthUrl ?? defaultBuildAuthUrl;

  const deps: StartDeps = {
    getCurrentUser: async () => user,
    // Grant admin iff the requested role is at or below the configured
    // role rank. Simplified version of the real hasRole that the test
    // controls directly — lets a test say "this user is an editor,
    // asking for admin must fail".
    hasRole: (u, requested) => {
      if (!u) return false;
      const rank = { viewer: 0, editor: 1, admin: 2 } as const;
      return rank[role] >= rank[requested];
    },
    logAction: async (entry) => {
      logs.push(entry);
    },
    findTeamById: async (id) => {
      findTeamCalls.push(id);
      return overrides.team === undefined ? { id } : overrides.team;
    },
    signState: (input) => {
      signCalls.push(input);
      return innerSign(input);
    },
    buildAuthUrl: (input) => {
      buildCalls.push(input);
      return innerBuild(input);
    },
    env: { ...FULL_ENV, ...(overrides.env ?? {}) },
  };

  return { deps, logs, findTeamCalls, signCalls, buildCalls };
}

// Narrow StartResult -> JSON branch with an assert so the rest of the
// test body can access .status/.body without the TS `never` detour.
function assertJson(r: StartResult): {
  status: number;
  body: Record<string, unknown>;
} {
  assert.equal(r.kind, "json");
  if (r.kind !== "json") throw new Error("unreachable");
  return r;
}

function assertRedirect(r: StartResult): {
  status: number;
  location: string;
  cookies?: CookieSpec[];
} {
  assert.equal(r.kind, "redirect");
  if (r.kind !== "redirect") throw new Error("unreachable");
  return r;
}

// --- Tests ---------------------------------------------------------

test("401 when no user session — no audit, no state-signing side effects", async () => {
  // The "no session" branch MUST short-circuit before any of the
  // downstream deps run, otherwise a misconfigured env or a deleted
  // team would leak into the response body for an unauthenticated
  // probe (info-leak). Assert all downstream dep call arrays stay
  // empty.
  const { deps, logs, findTeamCalls, signCalls, buildCalls } = makeDeps({
    user: null,
  });
  const r = await startHandler(makeReq(), deps);
  const { status, body } = assertJson(r);
  assert.equal(status, 401);
  assert.equal(body.ok, false);
  assert.equal(body.error, "unauthorized");
  assert.deepEqual(logs, []);
  assert.deepEqual(findTeamCalls, []);
  assert.deepEqual(signCalls, []);
  assert.deepEqual(buildCalls, []);
});

test("403 when user is editor (not admin) — emits denied audit with reason=not_admin", async () => {
  // Admin-only is load-bearing: an editor connecting a personal
  // Gmail to the office team record would silently exfiltrate
  // every future invitation. The denied audit gives ops a tripwire.
  const { deps, logs, signCalls, buildCalls } = makeDeps({
    user: EDITOR,
    role: "editor",
  });
  const r = await startHandler(makeReq(), deps);
  const { status, body } = assertJson(r);
  assert.equal(status, 403);
  assert.equal(body.error, "forbidden");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "oauth.google.denied");
  assert.equal(logs[0].actorId, EDITOR.id);
  assert.deepEqual(logs[0].data, {
    reason: "not_admin",
    userId: EDITOR.id,
  });
  // No state signing on a rejected request.
  assert.deepEqual(signCalls, []);
  assert.deepEqual(buildCalls, []);
});

test("503 when all 4 OAuth env vars are missing — hint lists every name", async () => {
  // Ops-visibility test. Missing ONE var is the same kind of error
  // as missing ALL four as far as the response shape goes; pinning
  // the all-missing case proves the hint builder doesn't choke on
  // a fully-empty env (empty join, empty array).
  const { deps, logs, signCalls } = makeDeps({
    env: {
      GOOGLE_OAUTH_CLIENT_ID: undefined,
      GOOGLE_OAUTH_CLIENT_SECRET: undefined,
      GOOGLE_OAUTH_REDIRECT_URI: undefined,
      OAUTH_ENCRYPTION_KEY: undefined,
    },
  });
  const r = await startHandler(makeReq(), deps);
  const { status, body } = assertJson(r);
  assert.equal(status, 503);
  assert.equal(body.error, "oauth_not_configured");
  assert.equal(typeof body.hint, "string");
  const hint = body.hint as string;
  // Each variable must be named in the hint so the operator doesn't
  // have to guess which ones are missing.
  assert.ok(hint.includes("GOOGLE_OAUTH_CLIENT_ID"), hint);
  assert.ok(hint.includes("GOOGLE_OAUTH_CLIENT_SECRET"), hint);
  assert.ok(hint.includes("GOOGLE_OAUTH_REDIRECT_URI"), hint);
  assert.ok(hint.includes("OAUTH_ENCRYPTION_KEY"), hint);

  // The audit log must carry the missing-names list so ops can query
  // "how many times did we 503 with FOO missing this week".
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "oauth.google.error");
  const data = logs[0].data as { reason: string; missing: string[] };
  assert.equal(data.reason, "not_configured");
  assert.deepEqual(data.missing.slice().sort(), [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REDIRECT_URI",
    "OAUTH_ENCRYPTION_KEY",
  ]);

  // Fail-fast: the env check must short-circuit before we try to
  // sign state. Otherwise a broken deploy would still burn an HMAC.
  assert.deepEqual(signCalls, []);
});

test("503 when only ONE env var is missing — hint names exactly that one", async () => {
  // The narrow case: if three vars are set and one is missing, the
  // error must isolate the missing one rather than dump the full
  // list. Otherwise operator reading the hint would waste time
  // re-checking already-set vars.
  const { deps, logs } = makeDeps({
    env: { GOOGLE_OAUTH_REDIRECT_URI: undefined },
  });
  const r = await startHandler(makeReq(), deps);
  const { status, body } = assertJson(r);
  assert.equal(status, 503);
  const hint = body.hint as string;
  assert.ok(hint.includes("GOOGLE_OAUTH_REDIRECT_URI"), hint);
  assert.ok(!hint.includes("GOOGLE_OAUTH_CLIENT_ID"), hint);
  assert.ok(!hint.includes("GOOGLE_OAUTH_CLIENT_SECRET"), hint);
  assert.ok(!hint.includes("OAUTH_ENCRYPTION_KEY"), hint);

  const data = logs[0].data as { missing: string[] };
  assert.deepEqual(data.missing, ["GOOGLE_OAUTH_REDIRECT_URI"]);
});

test("303 redirect to /settings?oauth=google_failed&reason=invalid_team when teamId unknown", async () => {
  // Up-front teamId validation. The failure mode this prevents: the
  // callback would otherwise blow up on an FK violation when it
  // tries to upsert the OAuthAccount row, leaving the admin staring
  // at a raw 500 after returning from Google. Redirecting here
  // short-circuits the round trip.
  const { deps, logs, signCalls, buildCalls } = makeDeps({
    team: null, // team lookup returns null
  });
  const r = await startHandler(makeReq("?teamId=deleted-team-7"), deps);
  const { status, location } = assertRedirect(r);
  assert.equal(status, 303);
  const url = new URL(location);
  assert.equal(url.origin, "https://app.example.gov");
  assert.equal(url.pathname, "/settings");
  assert.equal(url.searchParams.get("oauth"), "google_failed");
  assert.equal(url.searchParams.get("reason"), "invalid_team");

  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "oauth.google.denied");
  assert.deepEqual(logs[0].data, {
    reason: "invalid_team",
    userId: ADMIN.id,
    teamId: "deleted-team-7",
  });

  // Signed state binds the teamId into the callback's trust
  // contract. We must NOT sign when the team doesn't exist —
  // otherwise a stale signed state for a ghost team could survive
  // past this check on some other request path.
  assert.deepEqual(signCalls, []);
  assert.deepEqual(buildCalls, []);
});

test("happy path office-wide (no teamId): signs with null, redirects 302, sets nonce cookie", async () => {
  const { deps, logs, findTeamCalls, signCalls, buildCalls } = makeDeps();
  const r = await startHandler(makeReq(), deps);
  const { status, location, cookies } = assertRedirect(r);

  // 302 mirrors NextResponse.redirect's default — existing clients
  // (e.g. the <a href> on /settings) expect this exact code.
  assert.equal(status, 302);
  assert.ok(
    location.startsWith("https://accounts.google.com/oauth/authorize"),
    location,
  );

  // No teamId in the URL -> no team lookup.
  assert.deepEqual(findTeamCalls, []);

  // signState must receive null (office-wide), not the string "null"
  // or undefined — the callback reads teamId === "" for office-wide.
  assert.deepEqual(signCalls, [{ teamId: null }]);

  // buildAuthUrl forwarded the 4 required inputs, no loginHint.
  assert.equal(buildCalls.length, 1);
  assert.equal(buildCalls[0].clientId, FULL_ENV.GOOGLE_OAUTH_CLIENT_ID);
  assert.equal(buildCalls[0].redirectUri, FULL_ENV.GOOGLE_OAUTH_REDIRECT_URI);
  assert.equal(buildCalls[0].state, "signed-state-abc");
  assert.equal(buildCalls[0].loginHint, undefined);

  // Nonce cookie — the second CSRF layer. Check every option that
  // matters for correctness.
  assert.ok(cookies);
  assert.equal(cookies.length, 1);
  const c = cookies[0];
  assert.equal(c.name, NONCE_COOKIE);
  assert.equal(c.value, "nonce-xyz");
  assert.equal(c.options.httpOnly, true);
  assert.equal(c.options.sameSite, "lax");
  // Path narrowed to the OAuth subtree — no reason for other routes
  // to see this cookie, and narrowing limits CSRF blast radius.
  assert.equal(c.options.path, "/api/oauth/google");
  assert.equal(c.options.maxAge, NONCE_COOKIE_MAX_AGE_S);
  // NODE_ENV=test -> secure must be false (otherwise local dev can't
  // set the cookie over http://localhost).
  assert.equal(c.options.secure, false);

  // Audit ties the flow start to the admin's actorId. Without this
  // entry there's no record that the office mailbox went through an
  // attempted reconnect — critical for incident timelines.
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "oauth.google.start");
  assert.equal(logs[0].refType, "team");
  assert.equal(logs[0].refId, undefined); // office-wide -> no refId
  assert.equal(logs[0].actorId, ADMIN.id);
  assert.deepEqual(logs[0].data, { userId: ADMIN.id, teamId: null });
});

test("happy path team-scoped: teamId flows into signState and audit", async () => {
  const { deps, logs, findTeamCalls, signCalls, buildCalls } = makeDeps({
    team: { id: "team-x" },
  });
  const r = await startHandler(makeReq("?teamId=team-x"), deps);
  const { status, cookies } = assertRedirect(r);
  assert.equal(status, 302);

  // Team existence was verified before we signed.
  assert.deepEqual(findTeamCalls, ["team-x"]);

  // signState received the teamId verbatim — this is the signed
  // contract the callback will verify against the cookie nonce.
  assert.deepEqual(signCalls, [{ teamId: "team-x" }]);

  assert.equal(buildCalls.length, 1);

  // Cookie still gets set on the team-scoped path.
  assert.ok(cookies);
  assert.equal(cookies[0].name, NONCE_COOKIE);

  // Audit carries both the actorId (who) and teamId (which mailbox
  // slot) so ops can answer "who tried to connect team-x's Gmail".
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "oauth.google.start");
  assert.equal(logs[0].refType, "team");
  assert.equal(logs[0].refId, "team-x");
  assert.deepEqual(logs[0].data, { userId: ADMIN.id, teamId: "team-x" });
});

test("login_hint query param forwards to buildAuthUrl (UX passthrough)", async () => {
  const { deps, buildCalls } = makeDeps();
  await startHandler(makeReq("?hint=admin%40office.gov"), deps);
  assert.equal(buildCalls.length, 1);
  assert.equal(buildCalls[0].loginHint, "admin@office.gov");
});

test("NODE_ENV=production sets cookie.secure=true (no http transport for the nonce)", async () => {
  // The nonce is the second CSRF factor. Shipping it over plaintext
  // in production would defeat the belt-and-suspenders layering —
  // so `secure: process.env.NODE_ENV === "production"` is the code
  // path that MUST hold. Pin it.
  const { deps } = makeDeps({ env: { NODE_ENV: "production" } });
  const r = await startHandler(makeReq(), deps);
  const { cookies } = assertRedirect(r);
  assert.ok(cookies);
  assert.equal(cookies[0].options.secure, true);
});

test("failure redirect origin honors APP_BASE_URL (not hardcoded localhost)", async () => {
  // redirectFailed() uses baseUrl() with APP_BASE_URL precedence.
  // A past bug would have sent production admins to
  // http://localhost:3000/settings after a team-validation failure.
  const { deps } = makeDeps({
    team: null,
    env: { APP_BASE_URL: "https://protocol.example.gov" },
  });
  const r = await startHandler(makeReq("?teamId=bogus"), deps);
  const { location } = assertRedirect(r);
  assert.equal(
    new URL(location).origin,
    "https://protocol.example.gov",
    "APP_BASE_URL must be the origin for the 303 redirect",
  );
});
