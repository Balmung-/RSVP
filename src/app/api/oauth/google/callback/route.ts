import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import {
  exchangeCode,
  fetchUserInfo,
  GOOGLE_SCOPES,
} from "@/lib/oauth/google";
import { verifyState } from "@/lib/oauth/state";
import { encryptSecret } from "@/lib/secrets";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/oauth/google/callback?code=...&state=...   (success)
// GET /api/oauth/google/callback?error=access_denied  (user declined)
//
// Closes the Gmail OAuth loop opened by `/start`.
//
// Every failure path audits a distinct reason so an operator can
// diagnose from eventLog alone — CSRF-rejected states, user-denied
// consents, and transient Google 5xx responses all look different in
// the log. The USER-FACING response is a redirect to /settings with a
// query flag; we don't surface raw Google errors to the browser.
//
// Role re-check: even though /start is admin-gated, the callback
// re-checks because an admin could have been demoted in the 30s
// window between redirect and return. Belt-and-suspenders.

const NONCE_COOKIE = "oauth.google.nonce";
const SETTINGS_OK = "/settings?oauth=google_connected";
const SETTINGS_ERR = (reason: string) =>
  `/settings?oauth=google_failed&reason=${encodeURIComponent(reason)}`;

function redirectWith(res: string) {
  // 303 keeps any method-specific semantics from leaking; GET-to-GET
  // redirect is what we want.
  return NextResponse.redirect(new URL(res, baseUrl()), 303);
}

function baseUrl(): string {
  return (
    process.env.APP_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  );
}

function clearNonceCookie() {
  cookies().set(NONCE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/oauth/google",
    maxAge: 0,
  });
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || !hasRole(user, "admin")) {
    clearNonceCookie();
    await logAction({
      kind: "oauth.google.denied",
      data: { reason: "not_admin_on_callback", userId: user?.id ?? null },
      actorId: user?.id ?? null,
    });
    return redirectWith(SETTINGS_ERR("forbidden"));
  }

  const url = new URL(req.url);
  const err = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  // User clicked "deny" on Google's consent screen, or Google rejected
  // the client for policy reasons. Both arrive as `?error=...`.
  if (err) {
    clearNonceCookie();
    await logAction({
      kind: "oauth.google.denied",
      data: { reason: err, userId: user.id },
      actorId: user.id,
    });
    return redirectWith(SETTINGS_ERR(err));
  }

  if (!code || !stateParam) {
    clearNonceCookie();
    await logAction({
      kind: "oauth.google.denied",
      data: { reason: "missing_code_or_state", userId: user.id },
      actorId: user.id,
    });
    return redirectWith(SETTINGS_ERR("malformed"));
  }

  // Verify signed state. Failure modes are distinct so audit can
  // capture the specific reason; operators diagnosing a broken flow
  // want to know "is it clock skew, a replay, or a missing secret?"
  const verdict = verifyState(stateParam);
  if (!verdict.ok) {
    clearNonceCookie();
    await logAction({
      kind: "oauth.google.denied",
      data: { reason: `state_${verdict.reason}`, userId: user.id },
      actorId: user.id,
    });
    return redirectWith(SETTINGS_ERR(`state_${verdict.reason}`));
  }

  // Cookie-bound nonce check — second CSRF layer. The signed-state
  // MAC alone is enough if SESSION_SECRET is perfectly confidential,
  // but pairing it with a per-flow cookie means an attacker who
  // briefly observes a valid state (log exposure, mis-configured CDN
  // cache) still can't complete the flow in the victim's session.
  const cookieNonce = cookies().get(NONCE_COOKIE)?.value ?? null;
  if (!cookieNonce || cookieNonce !== verdict.payload.nonce) {
    clearNonceCookie();
    await logAction({
      kind: "oauth.google.denied",
      data: { reason: "nonce_mismatch", userId: user.id },
      actorId: user.id,
    });
    return redirectWith(SETTINGS_ERR("nonce_mismatch"));
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    clearNonceCookie();
    await logAction({
      kind: "oauth.google.error",
      data: { reason: "not_configured", userId: user.id },
      actorId: user.id,
    });
    return redirectWith(SETTINGS_ERR("not_configured"));
  }

  // Exchange the one-time code for tokens. Google returns errors as
  // 4xx with a JSON body; our helper throws a descriptive Error in
  // those cases. We catch and audit — never surface raw Google
  // messages to the browser.
  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode({
      code,
      clientId,
      clientSecret,
      redirectUri,
    });
  } catch (e) {
    clearNonceCookie();
    await logAction({
      kind: "oauth.google.error",
      data: {
        reason: "exchange_failed",
        message: String(e).slice(0, 300),
        userId: user.id,
      },
      actorId: user.id,
    });
    return redirectWith(SETTINGS_ERR("exchange_failed"));
  }

  // We forced `prompt=consent` in the auth URL precisely so Google
  // always returns a refresh_token. Its absence means something
  // subtle broke (client misconfig, policy override, or the user
  // hit a pre-granted app with a different client_id). Fail loudly
  // rather than storing half a credential that silently stops
  // working at the first access-token expiry.
  if (!tokens.refresh_token) {
    clearNonceCookie();
    await logAction({
      kind: "oauth.google.error",
      data: { reason: "no_refresh_token", userId: user.id },
      actorId: user.id,
    });
    return redirectWith(SETTINGS_ERR("no_refresh_token"));
  }

  // Verify we actually got the scopes we asked for. Google splits the
  // granted scope string on spaces; a user can theoretically deselect
  // scopes in the consent screen. If gmail.send is missing we can't
  // send — better to fail the connection than to store a useless row.
  const grantedScopes = tokens.scope.split(/\s+/).filter(Boolean);
  const missingCritical = !grantedScopes.includes(
    "https://www.googleapis.com/auth/gmail.send",
  );
  if (missingCritical) {
    clearNonceCookie();
    await logAction({
      kind: "oauth.google.denied",
      data: {
        reason: "scope_incomplete",
        granted: tokens.scope,
        userId: user.id,
      },
      actorId: user.id,
    });
    return redirectWith(SETTINGS_ERR("scope_incomplete"));
  }

  // Look up the connected email. This also proves the access token
  // works before we persist — if userinfo fails, the token is broken
  // and we'd rather find out now than on first send.
  let info: Awaited<ReturnType<typeof fetchUserInfo>>;
  try {
    info = await fetchUserInfo({ accessToken: tokens.access_token });
  } catch (e) {
    clearNonceCookie();
    await logAction({
      kind: "oauth.google.error",
      data: {
        reason: "userinfo_failed",
        message: String(e).slice(0, 300),
        userId: user.id,
      },
      actorId: user.id,
    });
    return redirectWith(SETTINGS_ERR("userinfo_failed"));
  }

  // Encrypt both tokens at rest. Any throw here is a config issue
  // (OAUTH_ENCRYPTION_KEY missing/malformed) — we audit and bail.
  let accessTokenEnc: string;
  let refreshTokenEnc: string;
  try {
    accessTokenEnc = encryptSecret(tokens.access_token);
    refreshTokenEnc = encryptSecret(tokens.refresh_token);
  } catch (e) {
    clearNonceCookie();
    await logAction({
      kind: "oauth.google.error",
      data: {
        reason: "encryption_failed",
        message: String(e).slice(0, 200),
        userId: user.id,
      },
      actorId: user.id,
    });
    return redirectWith(SETTINGS_ERR("encryption_failed"));
  }

  // expires_in is seconds-from-now. Convert to an absolute Date so we
  // don't have to re-derive it every time a send pipeline checks
  // token freshness. Subtract a safety skew (60s) so "close to
  // expiry" refreshes fire before Google starts returning 401s.
  const tokenExpiresAt = new Date(
    Date.now() + Math.max(0, tokens.expires_in - 60) * 1000,
  );

  const teamId = verdict.payload.teamId || null;

  // Upsert on (provider, teamId). See schema — Postgres treats NULL
  // as distinct in unique constraints by default, so the teamId=null
  // ("office-wide") case is race-prone at the DB layer. We mitigate
  // by doing find-first + update-or-create in a transaction — two
  // concurrent admin clicks on the same connect button are rare in
  // practice (one human), and a leftover duplicate row is a harmless
  // GC target rather than a corruption.
  await prisma.$transaction(async (tx) => {
    const existing = await tx.oAuthAccount.findFirst({
      where: { provider: "google", teamId: teamId },
    });
    if (existing) {
      await tx.oAuthAccount.update({
        where: { id: existing.id },
        data: {
          googleEmail: info.email,
          accessTokenEnc,
          refreshTokenEnc,
          tokenExpiresAt,
          scopes: tokens.scope,
          connectedByUserId: user.id,
        },
      });
    } else {
      await tx.oAuthAccount.create({
        data: {
          provider: "google",
          teamId: teamId,
          googleEmail: info.email,
          accessTokenEnc,
          refreshTokenEnc,
          tokenExpiresAt,
          scopes: tokens.scope,
          connectedByUserId: user.id,
        },
      });
    }
  });

  clearNonceCookie();
  await logAction({
    kind: "oauth.google.connected",
    refType: "team",
    refId: teamId ?? undefined,
    data: {
      googleEmail: info.email,
      teamId,
      userId: user.id,
      // Scope list is useful for later audits if we ever widen
      // GOOGLE_SCOPES and want to know which rows were connected
      // before the widening.
      scopes: tokens.scope,
      requestedScopes: GOOGLE_SCOPES,
    },
    actorId: user.id,
  });

  return redirectWith(SETTINGS_OK);
}
