import { NextResponse } from "next/server";
import { cookies } from "next/headers";
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

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    // Config problem, not user-facing. Emit 503 + explicit hint so ops
    // can see where to look.
    return NextResponse.json(
      {
        ok: false,
        error: "oauth_not_configured",
        hint: "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_REDIRECT_URI.",
      },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const teamId = url.searchParams.get("teamId");
  // Optional login hint lets an admin with multiple Google accounts
  // pre-select the right chooser entry. Purely UX — no security role.
  const loginHint = url.searchParams.get("hint") ?? undefined;

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
