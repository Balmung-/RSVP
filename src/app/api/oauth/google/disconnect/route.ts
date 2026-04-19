import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { revokeGoogleToken } from "@/lib/oauth/google";
import { decryptSecret } from "@/lib/secrets";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/oauth/google/disconnect
//   body: (form-encoded or JSON) { teamId?: string }
//
// Removes a stored Google/Gmail connection. Attempts to revoke the
// refresh token at Google first, then deletes the local OAuthAccount
// row regardless of whether the remote revoke succeeded. This is
// deliberately fail-open on the remote side — a Google outage or
// intermittent 5xx should NOT strand the office in a half-disconnected
// state where:
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
//   - `oauth.google.error` — decrypt-failed, local-delete failed.

const SETTINGS_OK = "/settings?oauth=google_disconnected";
const SETTINGS_WARN = (reason: string) =>
  `/settings?oauth=google_disconnected_warn&reason=${encodeURIComponent(reason)}`;
const SETTINGS_ERR = (reason: string) =>
  `/settings?oauth=google_disconnect_failed&reason=${encodeURIComponent(reason)}`;

function baseUrl(): string {
  return (
    process.env.APP_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  );
}

function redirectWith(res: string) {
  return NextResponse.redirect(new URL(res, baseUrl()), 303);
}

// Accept either form-encoded or JSON. Only one optional field
// (teamId), so the parsing is deliberately forgiving — we want a
// plain <form> POST from /settings to work without a client-side
// JSON stringify.
async function readTeamId(req: Request): Promise<string | null> {
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await req.json().catch(() => ({}))) as { teamId?: unknown };
      return typeof body.teamId === "string" && body.teamId.length > 0
        ? body.teamId
        : null;
    }
    // form-encoded or multipart — FormData handles both.
    const fd = await req.formData().catch(() => null);
    const v = fd?.get("teamId");
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!hasRole(user, "admin")) {
    await logAction({
      kind: "oauth.google.denied",
      data: { reason: "not_admin_on_disconnect", userId: user.id },
      actorId: user.id,
    });
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const teamId = await readTeamId(req);

  // Match the send-path selection: if two duplicates survive, we
  // revoke whichever is freshest (updatedAt desc). The deleteMany
  // below catches any leftover duplicates from a prior NULL-race
  // regardless, so end state is always "zero rows for this slot".
  const account = await prisma.oAuthAccount.findFirst({
    where: { provider: "google", teamId },
    orderBy: [
      { updatedAt: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ],
  });

  if (!account) {
    // Idempotent: disconnecting an already-disconnected slot is a
    // no-op with a clear message. We DON'T emit `error` here because
    // no admin action was stopped — the desired end state matches
    // current state.
    await logAction({
      kind: "oauth.google.denied",
      data: {
        reason: "no_account",
        teamId,
        userId: user.id,
      },
      actorId: user.id,
    });
    return redirectWith(SETTINGS_ERR("no_account"));
  }

  // Decrypt the refresh token so we can ask Google to revoke it. If
  // OAUTH_ENCRYPTION_KEY is missing or the ciphertext is corrupt we
  // can't remote-revoke, but we CAN still clean up the local row —
  // leaving it behind would mean the admin can't reconnect, which is
  // worse than a stranded Google-side grant.
  let refreshToken: string | null = null;
  let decryptError: string | null = null;
  try {
    refreshToken = decryptSecret(account.refreshTokenEnc);
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
    const r = await revokeGoogleToken({ token: refreshToken });
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
    const result = await prisma.oAuthAccount.deleteMany({
      where: { provider: "google", teamId },
    });
    localDeleted = result.count;
  } catch (e) {
    // Local delete failed. This is a real problem — the stored row
    // still holds a (possibly revoked, possibly still-valid) refresh
    // token. Surface as an error so ops can investigate.
    await logAction({
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
    return redirectWith(SETTINGS_ERR("local_delete_failed"));
  }

  // Audit the successful disconnect with full remote-revoke outcome.
  // One row, rich data — easier to query later than splitting across
  // multiple kinds.
  await logAction({
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
    return redirectWith(SETTINGS_OK);
  }
  const warnReason = remoteSkipped
    ? "decrypt_failed"
    : revokeStatus === 0
      ? "network"
      : `remote_${revokeStatus}`;
  return redirectWith(SETTINGS_WARN(warnReason));
}
