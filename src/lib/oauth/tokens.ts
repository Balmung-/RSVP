import type { FetchLike } from "./google";
import { refreshAccessToken } from "./google";
import { decryptSecret, encryptSecret } from "../secrets";

// Shared token-freshness helper. Takes an OAuthAccount-ish row (the
// three fields it needs), returns an access token that's guaranteed
// valid for the next ~`skewMs` milliseconds.
//
// Why this is a standalone helper (not a method on a provider):
//   Future providers beyond Gmail will also need to "give me a live
//   access token, refresh if you must". Putting the
//   refresh-and-persist dance here means every provider gets the
//   same concurrency and revocation semantics for free.
//
// Concurrency — two sends notice expiry at the same time:
//   Both call refreshAccessToken. Google is fine with this; refresh
//   tokens are NOT single-use. Both get back valid access tokens.
//   Both call onRefresh to persist. The last write wins — losing
//   row is harmless because the winning row holds a usable access
//   token with a later expiry. We deliberately DON'T add a row-
//   level lock here: Gmail API is happy with two different valid
//   access tokens being used concurrently, and a DB lock would
//   serialize the entire send path behind one refresh.
//
// Revocation:
//   If Google returns `invalid_grant` on refresh, the user revoked
//   access (or the token was wiped by a Workspace admin). We throw
//   `TokenRevokedError` — a named subclass so the provider can
//   catch it specifically, emit `oauth.google.revoked` to audit,
//   and return a NON-retryable error. Any other refresh failure
//   (network, 5xx) stays retryable.

export class TokenRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRevokedError";
  }
}

export interface OAuthAccountLike {
  id: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  tokenExpiresAt: Date;
}

export interface GetFreshAccessTokenInput {
  account: OAuthAccountLike;
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
  // Wall-clock override for tests.
  now?: number;
  // Refresh when the token has less than this many ms of life left.
  // Default 60s — matches the 60s safety skew we bake into the
  // callback's `tokenExpiresAt = now + expires_in - 60`, so after a
  // fresh connect we don't immediately refresh on the first send.
  skewMs?: number;
  // Persist callback. Decoupled from Prisma so tests don't need a
  // DB fixture — pass a plain function that records the update.
  // Production caller (Gmail provider) passes a prisma.oAuthAccount
  // .update that writes the new ciphertext + expiry back to the
  // row in one roundtrip.
  onRefresh?: (update: {
    accountId: string;
    accessTokenEnc: string;
    tokenExpiresAt: Date;
  }) => Promise<void>;
}

export interface GetFreshAccessTokenResult {
  accessToken: string;
  // True when we actually called Google; false when we returned
  // the decrypted stored token. Callers use this to decide whether
  // to emit an `oauth.google.refreshed` audit (we only audit
  // refreshes, not every send).
  refreshed: boolean;
  // Populated only on refresh. Lets callers persist in a batch if
  // they want to combine the update with other row changes instead
  // of using onRefresh.
  newAccessTokenEnc?: string;
  newTokenExpiresAt?: Date;
}

// Pure freshness check — exposed for tests.
export function isStale(
  expiresAt: Date,
  opts: { now?: number; skewMs?: number } = {},
): boolean {
  const now = opts.now ?? Date.now();
  const skew = opts.skewMs ?? 60_000;
  return expiresAt.getTime() - now <= skew;
}

export async function getFreshAccessToken(
  input: GetFreshAccessTokenInput,
): Promise<GetFreshAccessTokenResult> {
  const { account } = input;
  if (!isStale(account.tokenExpiresAt, { now: input.now, skewMs: input.skewMs })) {
    // Fast path — still fresh. Decrypt the stored access token and
    // return without hitting Google.
    const accessToken = decryptSecret(account.accessTokenEnc);
    return { accessToken, refreshed: false };
  }

  // Refresh path. Decrypt the refresh token, call Google, re-
  // encrypt the new access token, report back.
  const refreshToken = decryptSecret(account.refreshTokenEnc);
  let resp: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    resp = await refreshAccessToken({
      refreshToken,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      fetchImpl: input.fetchImpl,
    });
  } catch (e) {
    // Translate Google's `invalid_grant` into a named error so
    // the provider can map to non-retryable without string-
    // matching the message. Everything else (network, 5xx,
    // config) keeps the raw Error and stays retryable upstream.
    const msg = String(e);
    if (/invalid_grant/.test(msg)) {
      throw new TokenRevokedError(msg);
    }
    throw e;
  }

  // 60s safety skew matches the callback — same rationale (refresh
  // before Google starts returning 401s on the real send).
  const newTokenExpiresAt = new Date(
    (input.now ?? Date.now()) + Math.max(0, resp.expires_in - 60) * 1000,
  );
  const newAccessTokenEnc = encryptSecret(resp.access_token);

  if (input.onRefresh) {
    // Persist. Errors here are infra problems; surface them so the
    // provider returns a retryable error rather than silently using
    // a token it can't write back.
    await input.onRefresh({
      accountId: account.id,
      accessTokenEnc: newAccessTokenEnc,
      tokenExpiresAt: newTokenExpiresAt,
    });
  }

  return {
    accessToken: resp.access_token,
    refreshed: true,
    newAccessTokenEnc,
    newTokenExpiresAt,
  };
}
