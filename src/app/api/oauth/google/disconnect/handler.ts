import type { User } from "@prisma/client";
import type { Role } from "@/lib/auth";
import type { RevokeResult } from "@/lib/oauth/google";

// Pure handler for POST /api/oauth/google/disconnect.
//
// The accompanying route.ts exports a POST wrapper that:
//   - resolves real deps (getCurrentUser, prisma.oAuthAccount,
//     logAction, revokeGoogleToken, decryptSecret, process.env),
//   - calls this handler,
//   - translates the returned result to NextResponse.
//
// This file is PURE: no Next.js imports, no Prisma import, no
// process.env reads, no decryptSecret import. Every side-effect
// surface is injected via `deps`. Tests can therefore verify each
// branch — success, decrypt-fail, remote-revoke-fail, local-delete-
// fail, no-account, not-admin — with plain stubs, no RSC runtime
// and no real database.

// ---- Types --------------------------------------------------------

export interface DisconnectEnv {
  APP_BASE_URL?: string;
  NEXT_PUBLIC_APP_URL?: string;
}

// Same discriminated shape the /start handler uses. Keeping the two
// handlers' result types parallel means the route wrappers share an
// identical translation pattern (and a future refactor could hoist
// the translation helper into a shared lib).
export type DisconnectResult =
  | { kind: "json"; status: number; body: Record<string, unknown> }
  | { kind: "redirect"; status: number; location: string };

export interface LogEntry {
  kind: string;
  refType?: string;
  refId?: string;
  data?: unknown;
  actorId?: string | null;
}

// Narrow account shape this handler needs. `refreshTokenEnc` is the
// only encrypted blob — access token doesn't need remote revocation
// (revoking refresh also invalidates derived access tokens per
// Google docs).
export interface DisconnectAccountRow {
  id: string;
  teamId: string | null;
  googleEmail: string;
  refreshTokenEnc: string;
}

export interface DisconnectDeps {
  getCurrentUser: () => Promise<User | null>;
  hasRole: (user: User | null | undefined, role: Role) => boolean;
  logAction: (entry: LogEntry) => Promise<void>;
  // Find the connected row for (provider=google, teamId). The
  // deterministic orderBy that the real wrapper passes (updatedAt
  // desc → createdAt desc → id desc) is the caller's concern — this
  // handler just wants the freshest survivor of any NULL-race
  // duplicate pair. See gmail.ts for the full rationale.
  findAccount: (teamId: string | null) => Promise<DisconnectAccountRow | null>;
  // Delete all rows for the slot — deleteMany, not delete — to
  // sweep up stragglers from a prior unique-constraint race.
  // Returns the count actually removed so the audit can log it.
  deleteAccounts: (teamId: string | null) => Promise<{ count: number }>;
  revokeGoogleToken: (input: { token: string }) => Promise<RevokeResult>;
  // Throws on corrupt ciphertext or missing OAUTH_ENCRYPTION_KEY.
  // The handler catches and maps to `decryptError`, so the stored
  // row is still cleaned up locally — see the fail-open rationale
  // below.
  decryptSecret: (enc: string) => string;
  env: DisconnectEnv;
}

// ---- Helpers ------------------------------------------------------

function baseUrl(env: DisconnectEnv): string {
  return (
    env.APP_BASE_URL ??
    env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  );
}

function toAbs(path: string, env: DisconnectEnv): string {
  return new URL(path, baseUrl(env)).toString();
}

const SETTINGS_OK = "/settings?oauth=google_disconnected";
const SETTINGS_WARN = (reason: string) =>
  `/settings?oauth=google_disconnected_warn&reason=${encodeURIComponent(reason)}`;
const SETTINGS_ERR = (reason: string) =>
  `/settings?oauth=google_disconnect_failed&reason=${encodeURIComponent(reason)}`;

// Accept either form-encoded or JSON. Only one optional field
// (teamId), so the parsing is deliberately forgiving — we want a
// plain <form> POST from /settings to work without a client-side
// JSON stringify. Parsing lives in the handler (not deps) because
// it's a pure function of the Request body; tests build a real
// Request via the Node 20 `Request` global.
async function readTeamId(req: Request): Promise<string | null> {
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await req.json().catch(() => ({}))) as { teamId?: unknown };
      return typeof body.teamId === "string" && body.teamId.length > 0
        ? body.teamId
        : null;
    }
    const fd = await req.formData().catch(() => null);
    const v = fd?.get("teamId");
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// ---- Handler ------------------------------------------------------

// POST /api/oauth/google/disconnect
//   body: (form-encoded or JSON) { teamId?: string }
//
// Removes a stored Google/Gmail connection. Attempts to revoke the
// refresh token at Google first, then deletes the local OAuthAccount
// row regardless of whether the remote revoke succeeded. This is
// deliberately fail-open on the remote side — a Google outage or
// intermittent 5xx should NOT strand the office in a half-
// disconnected state where:
//   (a) we still hold a refresh token we can't remote-revoke, and
//   (b) the admin can't reconnect because the unique constraint is
//       still occupied.
//
// If remote revoke fails we still drop the local row AND surface a
// warning on the redirect, so the operator knows to manually check
// Google's account-security page if they want belt-and-suspenders.
//
// Auth: admin-only. A non-admin disconnecting the office mailbox
// would silently break every future invitation send; matching the
// connect flow's admin gate is the obvious symmetry.
//
// CSRF: this is a POST-only handler that requires a valid session
// cookie (getCurrentUser returns null for unauthenticated). The
// session cookie's sameSite=Lax setting blocks cross-site POSTs.
// Disconnect is a destructive action, but the blast radius is
// "admin has to re-connect" not "data loss" — the tradeoff we
// accept is same-origin trust via the session cookie rather than a
// per-form CSRF token, matching the pattern used by savePrefs /
// signOut in settings.
//
// Audit kinds emitted:
//   - `oauth.google.disconnected` — admin-initiated successful
//     disconnect. `data` includes remote-revoke outcome so ops can
//     see which disconnects had to fall back to local-only cleanup.
//   - `oauth.google.denied` — not-admin / no-account cases.
//   - `oauth.google.error` — local-delete failed.
export async function disconnectHandler(
  req: Request,
  deps: DisconnectDeps,
): Promise<DisconnectResult> {
  const user = await deps.getCurrentUser();
  if (!user) {
    return {
      kind: "json",
      status: 401,
      body: { ok: false, error: "unauthorized" },
    };
  }
  if (!deps.hasRole(user, "admin")) {
    await deps.logAction({
      kind: "oauth.google.denied",
      data: { reason: "not_admin_on_disconnect", userId: user.id },
      actorId: user.id,
    });
    return {
      kind: "json",
      status: 403,
      body: { ok: false, error: "forbidden" },
    };
  }

  const teamId = await readTeamId(req);

  const account = await deps.findAccount(teamId);
  if (!account) {
    // Idempotent: disconnecting an already-disconnected slot is a
    // no-op with a clear message. We DON'T emit `error` here because
    // no admin action was stopped — the desired end state matches
    // current state.
    await deps.logAction({
      kind: "oauth.google.denied",
      data: { reason: "no_account", teamId, userId: user.id },
      actorId: user.id,
    });
    return {
      kind: "redirect",
      status: 303,
      location: toAbs(SETTINGS_ERR("no_account"), deps.env),
    };
  }

  // Decrypt the refresh token so we can ask Google to revoke it. If
  // OAUTH_ENCRYPTION_KEY is missing or the ciphertext is corrupt we
  // can't remote-revoke, but we CAN still clean up the local row —
  // leaving it behind would mean the admin can't reconnect, which is
  // worse than a stranded Google-side grant.
  let refreshToken: string | null = null;
  let decryptError: string | null = null;
  try {
    refreshToken = deps.decryptSecret(account.refreshTokenEnc);
  } catch (e) {
    decryptError = String(e).slice(0, 200);
  }

  // Attempt remote revoke. Helper is no-throw by contract.
  let revokeOk = false;
  let revokeStatus = 0;
  let revokeError: string | undefined;
  let revokeAlreadyInvalid = false;
  let remoteSkipped = false;
  if (refreshToken) {
    const r = await deps.revokeGoogleToken({ token: refreshToken });
    revokeOk = r.ok;
    revokeStatus = r.status;
    revokeAlreadyInvalid = r.alreadyInvalid;
    revokeError = r.error;
  } else {
    remoteSkipped = true;
    revokeError = decryptError ?? "no_refresh_token";
  }

  // Local delete — deleteMany not delete, so we also sweep up any
  // NULL-race duplicates that somehow survived (matches the callback's
  // cleanup pattern). teamId is the same null-or-id we looked up with.
  let localDeleted = 0;
  try {
    const result = await deps.deleteAccounts(teamId);
    localDeleted = result.count;
  } catch (e) {
    // Local delete failed. This is a real problem — the stored row
    // still holds a (possibly revoked, possibly still-valid) refresh
    // token. Surface as an error so ops can investigate.
    await deps.logAction({
      kind: "oauth.google.error",
      data: {
        reason: "local_delete_failed",
        message: String(e).slice(0, 300),
        teamId,
        googleEmail: account.googleEmail,
        userId: user.id,
        remoteRevoke: revokeOk ? "ok" : remoteSkipped ? "skipped" : "failed",
      },
      actorId: user.id,
    });
    return {
      kind: "redirect",
      status: 303,
      location: toAbs(SETTINGS_ERR("local_delete_failed"), deps.env),
    };
  }

  // Audit the successful disconnect with full remote-revoke outcome.
  // One row, rich data — easier to query later than splitting across
  // multiple kinds.
  await deps.logAction({
    kind: "oauth.google.disconnected",
    refType: "oauthAccount",
    refId: account.id,
    data: {
      teamId,
      googleEmail: account.googleEmail,
      userId: user.id,
      localDeleted,
      remoteRevoke: remoteSkipped
        ? "skipped"
        : revokeAlreadyInvalid
          ? "already_invalid"
          : revokeOk
            ? "ok"
            : "failed",
      remoteRevokeStatus: remoteSkipped ? null : revokeStatus,
      remoteRevokeError: revokeError ?? null,
      decryptError,
    },
    actorId: user.id,
  });

  // Redirect semantics:
  //   - remote revoke ok (including already_invalid)   -> clean success
  //   - remote revoke failed OR skipped (decrypt fail) -> local-only
  //     success with a warning so the operator knows to check Google's
  //     account-security page if they want to be extra sure.
  if (revokeOk) {
    return {
      kind: "redirect",
      status: 303,
      location: toAbs(SETTINGS_OK, deps.env),
    };
  }
  const warnReason = remoteSkipped
    ? "decrypt_failed"
    : revokeStatus === 0
      ? "network"
      : `remote_${revokeStatus}`;
  return {
    kind: "redirect",
    status: 303,
    location: toAbs(SETTINGS_WARN(warnReason), deps.env),
  };
}
