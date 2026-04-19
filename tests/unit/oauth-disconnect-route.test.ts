import { test } from "node:test";
import assert from "node:assert/strict";
import type { User } from "@prisma/client";
import type { Role } from "../../src/lib/auth";
import type { RevokeResult } from "../../src/lib/oauth/google";
import {
  disconnectHandler,
  type DisconnectAccountRow,
  type DisconnectDeps,
  type DisconnectEnv,
  type DisconnectResult,
  type LogEntry,
} from "../../src/app/api/oauth/google/disconnect/handler";

// Route-level tests for POST /api/oauth/google/disconnect. They pin
// each branch of the disconnect decision tree — a 7-way fork that
// determines whether the admin sees a clean /settings toast, a
// local-only warning, or a hard error redirect:
//
//   - 401 unauthorized                -> no session
//   - 403 forbidden (denied audit)    -> editor/viewer reached a POST
//   - 303 no_account (denied audit)   -> admin clicked disconnect on an
//                                        empty slot — idempotent no-op
//   - 303 SETTINGS_OK                 -> decrypt ok, remote revoke ok,
//                                        local delete ok — the happy path
//   - 303 SETTINGS_OK (already_inv)   -> revoke returns 400 invalid_token;
//                                        treat as success (already the
//                                        desired end state)
//   - 303 SETTINGS_WARN/decrypt_failed-> decryptSecret threw; local still
//                                        wiped, operator warned
//   - 303 SETTINGS_WARN/network       -> fetch failed (status=0); local
//                                        wiped, operator warned
//   - 303 SETTINGS_WARN/remote_<n>    -> Google returned a non-200 non-400;
//                                        local wiped, operator warned with
//                                        the specific status code in the
//                                        reason so ops can differentiate
//                                        403 (revoked-access) from 500
//                                        (Google outage)
//   - 303 SETTINGS_ERR/local_delete_failed -> deleteMany threw; error audit
//
// Also pins body-parsing: both form-encoded and JSON must extract
// `teamId` so the settings form can POST without JSON-stringify.

// --- Helpers -------------------------------------------------------

const ENV: DisconnectEnv = {
  APP_BASE_URL: "https://app.example.gov",
};

const ADMIN: User = { id: "user-admin-1" } as unknown as User;
const EDITOR: User = { id: "user-editor-1" } as unknown as User;

const FAKE_ACCOUNT: DisconnectAccountRow = {
  id: "acct-1",
  teamId: null,
  googleEmail: "office@example.gov",
  refreshTokenEnc: "enc::refresh",
};

function makeReq(body?: BodyInit, contentType?: string): Request {
  return new Request("https://app.example.gov/api/oauth/google/disconnect", {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : undefined,
    body,
  });
}

function formReq(fields: Record<string, string>): Request {
  return makeReq(
    new URLSearchParams(fields).toString(),
    "application/x-www-form-urlencoded",
  );
}

function jsonReq(obj: Record<string, unknown>): Request {
  return makeReq(JSON.stringify(obj), "application/json");
}

// Capture-style deps. Account lookup + delete + revoke + decrypt are
// all either (a) injected as an override, or (b) served by a default
// that records its call args so tests can assert side-effects.
function makeDeps(overrides: {
  user?: User | null;
  role?: Role;
  account?: DisconnectAccountRow | null;
  // Explicit null for deleteAccounts means "throw" — pairs with the
  // local_delete_failed branch.
  deleteAccountsThrows?: Error;
  deleteCount?: number;
  decryptThrows?: Error;
  revoke?: RevokeResult;
  env?: Partial<DisconnectEnv>;
} = {}) {
  const logs: LogEntry[] = [];
  const findCalls: Array<string | null> = [];
  const deleteCalls: Array<string | null> = [];
  const revokeCalls: Array<{ token: string }> = [];
  const decryptCalls: string[] = [];

  const user = overrides.user === undefined ? ADMIN : overrides.user;
  const role: Role = overrides.role ?? "admin";
  const account =
    overrides.account === undefined ? FAKE_ACCOUNT : overrides.account;
  const deleteCount = overrides.deleteCount ?? 1;
  const revokeResult: RevokeResult = overrides.revoke ?? {
    ok: true,
    status: 200,
    alreadyInvalid: false,
  };

  const deps: DisconnectDeps = {
    getCurrentUser: async () => user,
    hasRole: (u, requested) => {
      if (!u) return false;
      const rank = { viewer: 0, editor: 1, admin: 2 } as const;
      return rank[role] >= rank[requested];
    },
    logAction: async (entry) => {
      logs.push(entry);
    },
    findAccount: async (teamId) => {
      findCalls.push(teamId);
      return account;
    },
    deleteAccounts: async (teamId) => {
      deleteCalls.push(teamId);
      if (overrides.deleteAccountsThrows) throw overrides.deleteAccountsThrows;
      return { count: deleteCount };
    },
    revokeGoogleToken: async ({ token }) => {
      revokeCalls.push({ token });
      return revokeResult;
    },
    decryptSecret: (enc) => {
      decryptCalls.push(enc);
      if (overrides.decryptThrows) throw overrides.decryptThrows;
      return `decrypted::${enc}`;
    },
    env: { ...ENV, ...(overrides.env ?? {}) },
  };

  return {
    deps,
    logs,
    findCalls,
    deleteCalls,
    revokeCalls,
    decryptCalls,
  };
}

function assertJson(r: DisconnectResult): {
  status: number;
  body: Record<string, unknown>;
} {
  assert.equal(r.kind, "json");
  if (r.kind !== "json") throw new Error("unreachable");
  return r;
}

function assertRedirect(r: DisconnectResult): {
  status: number;
  location: string;
} {
  assert.equal(r.kind, "redirect");
  if (r.kind !== "redirect") throw new Error("unreachable");
  return r;
}

function parseRedirect(location: string) {
  const u = new URL(location);
  return {
    origin: u.origin,
    pathname: u.pathname,
    params: Object.fromEntries(u.searchParams.entries()),
  };
}

// --- Tests ---------------------------------------------------------

test("401 when no session — no audit, no downstream work", async () => {
  const { deps, logs, findCalls, deleteCalls, revokeCalls } = makeDeps({
    user: null,
  });
  const r = await disconnectHandler(formReq({}), deps);
  const { status, body } = assertJson(r);
  assert.equal(status, 401);
  assert.equal(body.error, "unauthorized");
  // Short-circuit: an unauthenticated probe must not reveal whether
  // an account exists for the office-wide slot (info-leak).
  assert.deepEqual(logs, []);
  assert.deepEqual(findCalls, []);
  assert.deepEqual(deleteCalls, []);
  assert.deepEqual(revokeCalls, []);
});

test("403 when user is editor — denied audit carries reason=not_admin_on_disconnect", async () => {
  // The audit reason is distinct from /start's `not_admin` so ops
  // can tell attempts to CONNECT vs. attempts to DISCONNECT apart in
  // the timeline — both bad, but different attack narratives.
  const { deps, logs, findCalls } = makeDeps({
    user: EDITOR,
    role: "editor",
  });
  const r = await disconnectHandler(formReq({}), deps);
  const { status, body } = assertJson(r);
  assert.equal(status, 403);
  assert.equal(body.error, "forbidden");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "oauth.google.denied");
  const data = logs[0].data as { reason: string; userId: string };
  assert.equal(data.reason, "not_admin_on_disconnect");
  assert.equal(data.userId, EDITOR.id);
  assert.equal(logs[0].actorId, EDITOR.id);
  // No account lookup on a rejected request.
  assert.deepEqual(findCalls, []);
});

test("no_account: redirects to SETTINGS_ERR with reason=no_account, emits denied audit", async () => {
  // Idempotent disconnect. If the admin double-submits, the second
  // submission must not 500 — it must redirect to /settings with a
  // readable reason. `oauth.google.denied` (not `error`) because no
  // admin action was stopped — the end state they want is already
  // the current state.
  const { deps, logs, deleteCalls, revokeCalls } = makeDeps({
    account: null,
  });
  const r = await disconnectHandler(formReq({}), deps);
  const { status, location } = assertRedirect(r);
  assert.equal(status, 303);
  const parsed = parseRedirect(location);
  assert.equal(parsed.pathname, "/settings");
  assert.equal(parsed.params.oauth, "google_disconnect_failed");
  assert.equal(parsed.params.reason, "no_account");

  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "oauth.google.denied");
  const data = logs[0].data as { reason: string; teamId: unknown };
  assert.equal(data.reason, "no_account");
  assert.equal(data.teamId, null);

  // No-account short-circuit: don't revoke or delete (nothing to
  // act on).
  assert.deepEqual(revokeCalls, []);
  assert.deepEqual(deleteCalls, []);
});

test("happy path: decrypt ok + revoke ok + delete ok -> SETTINGS_OK", async () => {
  const { deps, logs, findCalls, deleteCalls, revokeCalls, decryptCalls } =
    makeDeps();
  const r = await disconnectHandler(formReq({}), deps);
  const { status, location } = assertRedirect(r);
  assert.equal(status, 303);
  const parsed = parseRedirect(location);
  assert.equal(parsed.pathname, "/settings");
  assert.equal(parsed.params.oauth, "google_disconnected");
  assert.equal(parsed.params.reason, undefined);

  // Exact call order matters: look up row -> decrypt -> revoke remotely
  // -> delete locally. A refactor that swaps delete-before-revoke
  // would lose the token if revoke also fails.
  assert.deepEqual(findCalls, [null]);
  assert.deepEqual(decryptCalls, ["enc::refresh"]);
  assert.deepEqual(revokeCalls, [{ token: "decrypted::enc::refresh" }]);
  assert.deepEqual(deleteCalls, [null]);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "oauth.google.disconnected");
  assert.equal(logs[0].refType, "oauthAccount");
  assert.equal(logs[0].refId, "acct-1");
  const data = logs[0].data as {
    teamId: unknown;
    googleEmail: string;
    remoteRevoke: string;
    remoteRevokeStatus: number | null;
    remoteRevokeError: unknown;
    decryptError: unknown;
    localDeleted: number;
  };
  assert.equal(data.teamId, null);
  assert.equal(data.googleEmail, "office@example.gov");
  assert.equal(data.remoteRevoke, "ok");
  assert.equal(data.remoteRevokeStatus, 200);
  assert.equal(data.remoteRevokeError, null);
  assert.equal(data.decryptError, null);
  assert.equal(data.localDeleted, 1);
});

test("already_invalid remote revoke counts as success (idempotent retry path)", async () => {
  // A partial previous disconnect may have revoked remotely but
  // failed to delete locally — the retry sees 400 invalid_token from
  // Google and must converge. The audit shape MUST distinguish
  // "ok" from "already_invalid" so ops can track how often the
  // retry path is exercised.
  const { deps, logs } = makeDeps({
    revoke: { ok: true, status: 400, alreadyInvalid: true },
  });
  const r = await disconnectHandler(formReq({}), deps);
  const { location } = assertRedirect(r);
  const parsed = parseRedirect(location);
  // Still maps to the clean SETTINGS_OK (not warn) — the effect is
  // achieved.
  assert.equal(parsed.params.oauth, "google_disconnected");

  const data = logs[0].data as { remoteRevoke: string; remoteRevokeStatus: number };
  assert.equal(data.remoteRevoke, "already_invalid");
  assert.equal(data.remoteRevokeStatus, 400);
});

test("decrypt failure: skips remote revoke, deletes locally, warns with decrypt_failed", async () => {
  // The fail-open-on-remote rule in action. OAUTH_ENCRYPTION_KEY
  // rotation without re-encrypting stored tokens would land here.
  // Leaving the row in place would block reconnect forever — we'd
  // rather warn the operator and sweep the row.
  const err = new Error("key mismatch");
  const { deps, logs, revokeCalls, deleteCalls } = makeDeps({
    decryptThrows: err,
  });
  const r = await disconnectHandler(formReq({}), deps);
  const { location } = assertRedirect(r);
  const parsed = parseRedirect(location);
  assert.equal(parsed.params.oauth, "google_disconnected_warn");
  assert.equal(parsed.params.reason, "decrypt_failed");

  // Remote revoke must NOT be attempted with no plaintext token —
  // otherwise we'd send undefined/"" to Google and get a
  // misleading 400 that drowns out the real decrypt failure.
  assert.deepEqual(revokeCalls, []);
  // Local delete still ran — the whole point of fail-open.
  assert.deepEqual(deleteCalls, [null]);

  assert.equal(logs.length, 1);
  const data = logs[0].data as {
    remoteRevoke: string;
    remoteRevokeStatus: unknown;
    remoteRevokeError: string;
    decryptError: string;
  };
  assert.equal(data.remoteRevoke, "skipped");
  assert.equal(data.remoteRevokeStatus, null);
  assert.ok(data.decryptError.includes("key mismatch"), data.decryptError);
  // remoteRevokeError falls through to the decrypt message so a
  // single field captures "what stopped the revoke".
  assert.ok(data.remoteRevokeError.includes("key mismatch"), data.remoteRevokeError);
});

test("revoke network failure (status=0): warns with reason=network, still deletes locally", async () => {
  const { deps, logs, deleteCalls } = makeDeps({
    revoke: {
      ok: false,
      status: 0,
      alreadyInvalid: false,
      error: "network: fetch failed",
    },
  });
  const r = await disconnectHandler(formReq({}), deps);
  const { location } = assertRedirect(r);
  const parsed = parseRedirect(location);
  assert.equal(parsed.params.oauth, "google_disconnected_warn");
  assert.equal(parsed.params.reason, "network");
  // Fail-open: local row still wiped regardless of network failure.
  assert.deepEqual(deleteCalls, [null]);

  const data = logs[0].data as { remoteRevoke: string; remoteRevokeStatus: number };
  assert.equal(data.remoteRevoke, "failed");
  assert.equal(data.remoteRevokeStatus, 0);
});

test("revoke non-network failure (status=503): warns with reason=remote_<status>", async () => {
  // Differentiating network (status=0) from remote_5xx (status>=500)
  // matters because one is "the internet flaked" (transient) and the
  // other is "Google is telling us no" (might be persistent auth
  // problem). Tuck the status code into the reason so the operator
  // sees it on the /settings redirect without digging into logs.
  const { deps } = makeDeps({
    revoke: {
      ok: false,
      status: 503,
      alreadyInvalid: false,
      error: "temp unavailable",
    },
  });
  const r = await disconnectHandler(formReq({}), deps);
  const { location } = assertRedirect(r);
  const parsed = parseRedirect(location);
  assert.equal(parsed.params.oauth, "google_disconnected_warn");
  assert.equal(parsed.params.reason, "remote_503");
});

test("local_delete_failed: emits error audit, redirects to SETTINGS_ERR", async () => {
  // The only branch that lands on SETTINGS_ERR rather than WARN —
  // because here the stored row is STILL in the DB, which means the
  // admin cannot reconnect (unique-constraint blocked). Ops needs
  // to see this as an error, not a warning.
  const boom = new Error("connection pool exhausted");
  const { deps, logs } = makeDeps({ deleteAccountsThrows: boom });
  const r = await disconnectHandler(formReq({}), deps);
  const { status, location } = assertRedirect(r);
  assert.equal(status, 303);
  const parsed = parseRedirect(location);
  assert.equal(parsed.params.oauth, "google_disconnect_failed");
  assert.equal(parsed.params.reason, "local_delete_failed");

  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "oauth.google.error");
  const data = logs[0].data as {
    reason: string;
    message: string;
    remoteRevoke: string;
  };
  assert.equal(data.reason, "local_delete_failed");
  // remoteRevoke status must still be captured so ops know whether
  // the token got revoked at Google even though local wipe failed.
  assert.equal(data.remoteRevoke, "ok");
  assert.ok(data.message.includes("connection pool exhausted"), data.message);
});

test("form-encoded teamId flows through to findAccount and deleteAccounts", async () => {
  // Settings form posts url-encoded by default — assert both the
  // lookup AND the delete use the same teamId so they can't
  // accidentally diverge.
  const { deps, findCalls, deleteCalls, logs } = makeDeps({
    account: { ...FAKE_ACCOUNT, teamId: "team-x" },
  });
  const r = await disconnectHandler(formReq({ teamId: "team-x" }), deps);
  assertRedirect(r);
  assert.deepEqual(findCalls, ["team-x"]);
  assert.deepEqual(deleteCalls, ["team-x"]);
  // Audit payload must carry the team so "which slot got wiped" is
  // answerable from one log row.
  const data = logs[0].data as { teamId: string };
  assert.equal(data.teamId, "team-x");
});

test("JSON teamId body works (parity with form-encoded)", async () => {
  // Programmatic callers (e.g. a future admin CLI) may prefer JSON.
  // Parity test so we don't regress one path while fixing the other.
  const { deps, findCalls, deleteCalls } = makeDeps({
    account: { ...FAKE_ACCOUNT, teamId: "team-y" },
  });
  const r = await disconnectHandler(jsonReq({ teamId: "team-y" }), deps);
  assertRedirect(r);
  assert.deepEqual(findCalls, ["team-y"]);
  assert.deepEqual(deleteCalls, ["team-y"]);
});

test("empty teamId string in body is treated as null (office-wide)", async () => {
  // A form that POSTs `teamId=` (empty input) must not be treated
  // as "look for a team with id ''" — that would 404 the request on
  // a bogus lookup. Readers coerce empty -> null.
  const { deps, findCalls } = makeDeps();
  const r = await disconnectHandler(formReq({ teamId: "" }), deps);
  assertRedirect(r);
  assert.deepEqual(findCalls, [null]);
});

test("missing/invalid content-type falls back to form-parsing (forgiving)", async () => {
  // A bare Request with no content-type should still reach the
  // no_account branch cleanly — not throw. We mark as no_account in
  // this test via `account: null` so we can assert the handler
  // completed its normal flow.
  const { deps, findCalls } = makeDeps({ account: null });
  const req = new Request("https://app.example.gov/api/oauth/google/disconnect", {
    method: "POST",
  });
  const r = await disconnectHandler(req, deps);
  assertRedirect(r);
  // Fallback parse returns null teamId — the handler should still
  // have called findAccount once with null.
  assert.deepEqual(findCalls, [null]);
});

test("redirect origin honors APP_BASE_URL", async () => {
  const { deps } = makeDeps({
    env: { APP_BASE_URL: "https://protocol.example.gov" },
  });
  const r = await disconnectHandler(formReq({}), deps);
  const { location } = assertRedirect(r);
  assert.equal(new URL(location).origin, "https://protocol.example.gov");
});
