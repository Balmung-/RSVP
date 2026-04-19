// Google OAuth 2.0 helpers for Gmail-send on behalf of this protocol
// office. This file is PURE — no Prisma, no cookies, no process.env
// reads. Everything it needs is passed in, including `fetchImpl` so
// tests can inject a stub instead of hitting Google. The HTTP route
// handlers in `src/app/api/oauth/google/*` read env vars and session
// state, then call these helpers.
//
// Scope policy — minimal, send-only:
//   - `https://www.googleapis.com/auth/gmail.send` is the ONLY Gmail
//     scope. No .readonly, no .modify, no .labels. We send; we don't
//     read the mailbox. This is deliberate. A broader scope would let
//     a compromised app decrypt previous invitations, search contacts,
//     or delete threads — all things this product never needs.
//   - `openid email` so Google's userinfo endpoint can tell us which
//     address we're sending AS. Without it we'd have to prompt the
//     connecting admin to type their own email, which is both annoying
//     and a spoof vector. (Admin enters "ceo@office.gov" while
//     actually connecting their personal account — now the DB lies
//     about which mailbox we send from.)
//
// Offline access + prompt=consent:
//   - `access_type=offline` is how Google tells us to get a refresh
//     token. Without it we'd only get a ~1h access token and the user
//     would have to re-consent every hour. Fatal for a background
//     send-queue.
//   - `prompt=consent` forces the consent screen even on re-auth.
//     Google's default behavior is to reuse the previous grant
//     SILENTLY and — critically — NOT return a refresh token on
//     subsequent flows. If the first grant's refresh token got lost
//     (bad deploy, DB wipe, rotated encryption key), a silent re-auth
//     would leave us with an access token and no way to refresh it.
//     `prompt=consent` guarantees a fresh refresh token every time,
//     at the cost of one extra click during reconnect. Worth it.
//
// Error normalization:
//   - Google's OAuth endpoint returns errors as JSON bodies with
//     `{error, error_description}`. We surface those verbatim in the
//     thrown Error message — they're operator-visible (not
//     end-user-visible) and having the raw Google description saves
//     a debug round-trip. The route handler decides whether to audit
//     them as `oauth.google.denied` (invalid_grant, access_denied)
//     vs. `oauth.google.error` (transient network / 5xx).

export const GOOGLE_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL =
  "https://openidconnect.googleapis.com/v1/userinfo";

// Scopes we request. Kept as a constant so tests can import it and
// assert that the URL builder emits exactly this set — any future PR
// that widens scope triggers the test and forces a deliberate review.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
] as const;

// Minimal Fetch-like shape. We don't require the full DOM Fetch type
// because Node 20's global fetch is good enough and tests can pass a
// simple function. Using a structural type keeps this module free of
// DOM lib dependencies.
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface BuildAuthUrlInput {
  clientId: string;
  redirectUri: string;
  // State is a caller-provided opaque string. Callers MUST sign it
  // (HMAC) and verify it on callback — this module is oblivious to
  // state semantics on purpose. See `src/lib/oauth/state.ts`.
  state: string;
  // Login hint lets the user land on the right Google chooser entry
  // when they have multiple accounts. Optional; omit for generic flow.
  loginHint?: string;
}

export function buildAuthUrl(input: BuildAuthUrlInput): string {
  if (!input.clientId) throw new Error("buildAuthUrl: clientId required");
  if (!input.redirectUri) throw new Error("buildAuthUrl: redirectUri required");
  if (!input.state) throw new Error("buildAuthUrl: state required");
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
  });
  if (input.loginHint) {
    params.set("login_hint", input.loginHint);
  }
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

export interface ExchangeCodeInput {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}

export interface GoogleTokenResponse {
  // What Google actually returns. `refresh_token` is optional on the
  // wire (absent on silent re-auth), but we require prompt=consent
  // above so a successful exchange should always include it. The
  // route handler enforces presence and fails closed if missing,
  // which is why this helper returns it as optional — the helper
  // reports the truth, the route decides policy.
  access_token: string;
  expires_in: number; // seconds
  refresh_token?: string;
  scope: string;
  token_type: string; // always "Bearer" in practice
  id_token?: string;
}

export async function exchangeCode(
  input: ExchangeCodeInput,
): Promise<GoogleTokenResponse> {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  }).toString();
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    // Propagate Google's own error shape for operator visibility.
    const err = typeof json.error === "string" ? json.error : "unknown_error";
    const desc =
      typeof json.error_description === "string"
        ? json.error_description
        : `HTTP ${res.status}`;
    throw new Error(`google oauth exchange failed: ${err} — ${desc}`);
  }
  return assertTokenResponse(json);
}

export interface RefreshInput {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
}

// NOTE: refresh flow does NOT return a new refresh_token (Google's
// behavior). The stored refresh token is reused until the user
// revokes access, at which point the next refresh call throws and
// the route handler surfaces `oauth.google.revoked`.
export async function refreshAccessToken(
  input: RefreshInput,
): Promise<GoogleTokenResponse> {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const body = new URLSearchParams({
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
  }).toString();
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = typeof json.error === "string" ? json.error : "unknown_error";
    const desc =
      typeof json.error_description === "string"
        ? json.error_description
        : `HTTP ${res.status}`;
    throw new Error(`google oauth refresh failed: ${err} — ${desc}`);
  }
  return assertTokenResponse(json);
}

export interface UserInfo {
  sub: string; // Google's stable user id
  email: string;
  email_verified?: boolean;
}

export async function fetchUserInfo(input: {
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<UserInfo> {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await fetchImpl(GOOGLE_USERINFO_URL, {
    method: "GET",
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = typeof json.error === "string" ? json.error : "unknown_error";
    throw new Error(`google userinfo failed: ${err} (HTTP ${res.status})`);
  }
  if (typeof json.sub !== "string" || typeof json.email !== "string") {
    throw new Error(
      "google userinfo: missing sub/email in response (check that openid+email scopes were granted)",
    );
  }
  return {
    sub: json.sub,
    email: json.email,
    email_verified:
      typeof json.email_verified === "boolean" ? json.email_verified : undefined,
  };
}

// Narrow the untyped JSON blob from Google into our declared shape.
// We do NOT trust Google's response structure implicitly — a future
// API change that drops `access_token` would otherwise silently
// produce a row with undefined ciphertext and manifest as a
// decryption error three days later. Fail fast at the boundary.
function assertTokenResponse(json: Record<string, unknown>): GoogleTokenResponse {
  if (typeof json.access_token !== "string") {
    throw new Error("google token response missing access_token");
  }
  if (typeof json.expires_in !== "number") {
    throw new Error("google token response missing expires_in");
  }
  if (typeof json.scope !== "string") {
    throw new Error("google token response missing scope");
  }
  if (typeof json.token_type !== "string") {
    throw new Error("google token response missing token_type");
  }
  const out: GoogleTokenResponse = {
    access_token: json.access_token,
    expires_in: json.expires_in,
    scope: json.scope,
    token_type: json.token_type,
  };
  if (typeof json.refresh_token === "string") {
    out.refresh_token = json.refresh_token;
  }
  if (typeof json.id_token === "string") {
    out.id_token = json.id_token;
  }
  return out;
}
