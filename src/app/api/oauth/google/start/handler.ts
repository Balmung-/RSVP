import type { User } from "@prisma/client";
import type { Role } from "@/lib/auth";

// Pure handler for GET /api/oauth/google/start.
//
// The accompanying route.ts exports a GET wrapper that:
//   - resolves real deps (getCurrentUser, prisma, logAction, signState,
//     buildAuthUrl, process.env),
//   - calls this handler,
//   - translates the returned result to NextResponse + cookie jar.
//
// This file is PURE: no Next.js imports, no Prisma import, no
// `process.env` reads. Every piece of side-effect surface arrives via
// `deps`. Tests can then supply tiny stubs and make assertions on the
// returned result without needing an RSC runtime or a real database.
//
// The full end-to-end rationale for each branch (admin-only gate,
// layered CSRF via signed state + nonce cookie, fail-fast config
// check, up-front teamId validation) lives here because the route.ts
// wrapper is intentionally trivial. All of the "why" comments that
// used to live in route.ts moved with the logic.

// ---- Cookie constants ---------------------------------------------

export const NONCE_COOKIE = "oauth.google.nonce";
export const NONCE_COOKIE_MAX_AGE_S = 10 * 60; // matches signed-state MAX_AGE_MS

// ---- Types --------------------------------------------------------

// Shape of the env vars this handler consults. Mirrors `process.env`
// but narrowed — tests pass a plain object with just these keys.
export interface StartEnv {
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  OAUTH_ENCRYPTION_KEY?: string;
  APP_BASE_URL?: string;
  NEXT_PUBLIC_APP_URL?: string;
  NODE_ENV?: string;
}

// One cookie spec per entry. The route wrapper applies these via
// Next.js `cookies().set()`. Path + maxAge are mandatory so the
// wrapper never has to guess. The signature keeps things narrow:
// every cookie the start flow sets follows the same shape.
export interface CookieSpec {
  name: string;
  value: string;
  options: {
    httpOnly: boolean;
    sameSite: "lax" | "strict" | "none";
    secure: boolean;
    path: string;
    maxAge: number;
  };
}

export type StartResult =
  | { kind: "json"; status: number; body: Record<string, unknown> }
  | {
      kind: "redirect";
      // 302 for the Google auth URL (standard OAuth redirect), 303
      // for the /settings failure redirect (consistent with the
      // callback's `redirectFailed`). Tests assert the exact code
      // so a future refactor to 307/308 would be a deliberate change.
      status: number;
      location: string;
      cookies?: CookieSpec[];
    };

// Audit payload shape. Kept loose to match logAction's `data: unknown`
// contract — a future audit field added here doesn't require a type
// bump at the dep boundary.
export interface LogEntry {
  kind: string;
  refType?: string;
  refId?: string;
  data?: unknown;
  actorId?: string | null;
}

export interface StartDeps {
  getCurrentUser: () => Promise<User | null>;
  hasRole: (user: User | null | undefined, role: Role) => boolean;
  logAction: (entry: LogEntry) => Promise<void>;
  // Narrowed Prisma surface — handler only needs "does this team
  // exist?". Accepts a callable rather than a Prisma client so tests
  // don't have to fake the whole client.
  findTeamById: (id: string) => Promise<{ id: string } | null>;
  signState: (input: { teamId: string | null }) => {
    state: string;
    nonce: string;
  };
  buildAuthUrl: (input: {
    clientId: string;
    redirectUri: string;
    state: string;
    loginHint?: string;
  }) => string;
  env: StartEnv;
}

// ---- Helpers ------------------------------------------------------

function baseUrl(env: StartEnv): string {
  return (
    env.APP_BASE_URL ??
    env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  );
}

function redirectFailed(reason: string, env: StartEnv): StartResult {
  // Match the callback's error-redirect convention so /settings UI
  // (B1b) can render a single consistent "last OAuth attempt failed:
  // <reason>" surface regardless of which side of the flow blew up.
  const path = `/settings?oauth=google_failed&reason=${encodeURIComponent(reason)}`;
  return {
    kind: "redirect",
    status: 303,
    location: new URL(path, baseUrl(env)).toString(),
  };
}

// ---- Handler ------------------------------------------------------

// GET /api/oauth/google/start?teamId=<id>
//
// Kicks off the Gmail OAuth connect flow for an admin. Produces a
// signed `state` parameter and a redirect to Google's consent screen.
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
//   - B1 wires the office-wide slot end-to-end; team-specific
//     accounts come in B1b together with the UI picker. The code
//     path is already here so B1b is just a UI change.
export async function startHandler(
  req: Request,
  deps: StartDeps,
): Promise<StartResult> {
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
      data: { reason: "not_admin", userId: user.id },
      actorId: user.id,
    });
    return {
      kind: "json",
      status: 403,
      body: { ok: false, error: "forbidden" },
    };
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
    ["GOOGLE_OAUTH_CLIENT_ID", deps.env.GOOGLE_OAUTH_CLIENT_ID],
    ["GOOGLE_OAUTH_CLIENT_SECRET", deps.env.GOOGLE_OAUTH_CLIENT_SECRET],
    ["GOOGLE_OAUTH_REDIRECT_URI", deps.env.GOOGLE_OAUTH_REDIRECT_URI],
    ["OAUTH_ENCRYPTION_KEY", deps.env.OAUTH_ENCRYPTION_KEY],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k as string);
  if (missing.length > 0) {
    // Config problem, not user-facing. Emit 503 + explicit hint so ops
    // can see exactly which env vars are missing.
    await deps.logAction({
      kind: "oauth.google.error",
      data: { reason: "not_configured", userId: user.id, missing },
      actorId: user.id,
    });
    return {
      kind: "json",
      status: 503,
      body: {
        ok: false,
        error: "oauth_not_configured",
        hint: `Set ${missing.join(", ")}.`,
      },
    };
  }
  // After the guard, all four must be strings. Re-read with a non-
  // null assertion so TS keeps the types precise through buildAuthUrl.
  const clientId = deps.env.GOOGLE_OAUTH_CLIENT_ID!;
  const redirectUri = deps.env.GOOGLE_OAUTH_REDIRECT_URI!;

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
    const team = await deps.findTeamById(teamId);
    if (!team) {
      await deps.logAction({
        kind: "oauth.google.denied",
        data: { reason: "invalid_team", userId: user.id, teamId },
        actorId: user.id,
      });
      return redirectFailed("invalid_team", deps.env);
    }
  }

  const { state, nonce } = deps.signState({ teamId });
  const authUrl = deps.buildAuthUrl({
    clientId,
    redirectUri,
    state,
    loginHint,
  });

  const nonceCookie: CookieSpec = {
    name: NONCE_COOKIE,
    value: nonce,
    options: {
      httpOnly: true,
      sameSite: "lax", // Google redirects back to us — lax is required for cross-site nav cookies.
      secure: deps.env.NODE_ENV === "production",
      path: "/api/oauth/google",
      maxAge: NONCE_COOKIE_MAX_AGE_S,
    },
  };

  await deps.logAction({
    kind: "oauth.google.start",
    refType: "team",
    refId: teamId ?? undefined,
    data: { userId: user.id, teamId: teamId ?? null },
    actorId: user.id,
  });

  return {
    kind: "redirect",
    // 302 matches the original NextResponse.redirect default (no
    // explicit status) — keeps behavior identical for clients that
    // might have depended on the status code.
    status: 302,
    location: authUrl,
    cookies: [nonceCookie],
  };
}
