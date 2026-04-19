import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { buildAuthUrl } from "@/lib/oauth/google";
import { signState } from "@/lib/oauth/state";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/oauth/google/start?teamId=<id>
//
// Kicks off the Gmail OAuth connect flow for an admin. Produces a
// signed `state` parameter and redirects to Google's consent screen.
// The callback (`/api/oauth/google/callback`) verifies the state and
// stores encrypted tokens.
//
// Auth: admin-only. Gmail tokens are a high-value secret — an editor
// or viewer role-escalating to "connect the office Gmail to my
// personal account" would silently exfiltrate every future
// invitation. Callback also re-checks the admin role so even a stolen
// start URL can't be completed by a lesser role.
//
// Layered CSRF:
//   - State is HMAC-signed with SESSION_SECRET — a forged callback
//     cannot produce a valid MAC.
//   - Additionally, we set a short-lived `oauth.google.nonce` cookie
//     containing the signed state's nonce. The callback must match
//     both the signed state AND the cookie nonce. This guards against
//     a scenario where SESSION_SECRET is briefly exposed (e.g. a log
//     leak): even with a valid MAC, the attacker can't produce the
//     matching cookie on the victim's browser.
//
// Team scoping:
//   - `?teamId=<id>` binds the connection to a specific team. Omit
//     for office-wide connection (teamId=null in DB). The signed
//     state carries the teamId so the callback can't be tricked into
//     binding to a different team mid-flow.
//   - B1 only wires the office-wide slot end-to-end; team-specific
//     accounts come in B1b together with the UI picker. The code
//     path is already here so B1b is just a UI change.

const NONCE_COOKIE = "oauth.google.nonce";
const NONCE_COOKIE_MAX_AGE_S = 10 * 60; // matches signed-state MAX_AGE_MS

function baseUrl(): string {
  return (
    process.env.APP_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  );
}

function redirectFailed(reason: string) {
  // Match the callback's error-redirect convention so /settings UI
  // (B1b) can render a single consistent "last OAuth attempt failed:
  // <reason>" surface regardless of which side of the flow blew up.
  const target = `/settings?oauth=google_failed&reason=${encodeURIComponent(reason)}`;
  return NextResponse.redirect(new URL(target, baseUrl()), 303);
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!hasRole(user, "admin")) {
    await logAction({
      kind: "oauth.google.denied",
      data: { reason: "not_admin", userId: user.id },
      actorId: user.id,
    });
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // /start technically only needs CLIENT_ID + REDIRECT_URI to build the
  // authorization URL, but the round-trip requires CLIENT_SECRET at the
  // callback (for code exchange) and OAUTH_ENCRYPTION_KEY (to encrypt
  // tokens at rest). Checking all four here means an incomplete config
  // fails FAST with a clear error — without this check the admin gets
  // shipped through Google's consent screen and sees a stale-looking
  // "not_configured" redirect on return, which is the opaque-misconfig
  // UX B1b was built to eliminate. The /settings "Configured" gate
  // uses the same four-var set.
  const missing = [
    ["GOOGLE_OAUTH_CLIENT_ID", process.env.GOOGLE_OAUTH_CLIENT_ID],
    ["GOOGLE_OAUTH_CLIENT_SECRET", process.env.GOOGLE_OAUTH_CLIENT_SECRET],
    ["GOOGLE_OAUTH_REDIRECT_URI", process.env.GOOGLE_OAUTH_REDIRECT_URI],
    ["OAUTH_ENCRYPTION_KEY", process.env.OAUTH_ENCRYPTION_KEY],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k as string);
  if (missing.length > 0) {
    // Config problem, not user-facing. Emit 503 + explicit hint so ops
    // can see exactly which env vars are missing.
    await logAction({
      kind: "oauth.google.error",
      data: { reason: "not_configured", userId: user.id, missing },
      actorId: user.id,
    });
    return NextResponse.json(
      {
        ok: false,
        error: "oauth_not_configured",
        hint: `Set ${missing.join(", ")}.`,
      },
      { status: 503 },
    );
  }
  // After the guard, all four must be strings. Re-read with a non-
  // null assertion so TS keeps the types precise through buildAuthUrl.
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI!;

  const url = new URL(req.url);
  const teamId = url.searchParams.get("teamId");
  // Optional login hint lets an admin with multiple Google accounts
  // pre-select the right chooser entry. Purely UX — no security role.
  const loginHint = url.searchParams.get("hint") ?? undefined;

  // Validate teamId BEFORE signing state. Two reasons this has to
  // happen here rather than in the callback:
  //   (1) Signed state is the contract the callback trusts. If we
  //       signed "teamId=XYZ" now and validated only on callback,
  //       the callback would either have to throw raw 500s on FK
  //       violations (bad) or re-do work (ugly). Validating up front
  //       means by the time state is signed, the teamId is known to
  //       point at a real row.
  //   (2) Belt-and-suspenders: the callback STILL catches persistence
  //       errors and maps them to a handled reason — see `team_gone`
  //       there — because a team can be deleted in the 10-minute
  //       window between /start and /callback. We just don't want to
  //       rely on the callback's catch as the FIRST line of defense.
  if (teamId) {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) {
      await logAction({
        kind: "oauth.google.denied",
        data: { reason: "invalid_team", userId: user.id, teamId },
        actorId: user.id,
      });
      return redirectFailed("invalid_team");
    }
  }

  const { state, nonce } = signState({ teamId });
  const authUrl = buildAuthUrl({
    clientId,
    redirectUri,
    state,
    loginHint,
  });

  cookies().set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax", // Google redirects back to us — lax is required for cross-site nav cookies.
    secure: process.env.NODE_ENV === "production",
    path: "/api/oauth/google",
    maxAge: NONCE_COOKIE_MAX_AGE_S,
  });

  await logAction({
    kind: "oauth.google.start",
    refType: "team",
    refId: teamId ?? undefined,
    data: { userId: user.id, teamId: teamId ?? null },
    actorId: user.id,
  });

  return NextResponse.redirect(authUrl);
}
