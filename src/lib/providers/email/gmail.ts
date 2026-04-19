import { prisma } from "../../db";
import { logAction } from "../../audit";
import {
  getFreshAccessToken,
  TokenRevokedError,
} from "../../oauth/tokens";
import { buildRawMessage } from "./gmail-mime";
import type { EmailMessage, EmailProvider, SendResult } from "../types";

const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// Gmail send adapter. Turn on with EMAIL_PROVIDER=gmail. The actual
// mailbox comes from the OAuthAccount row written by the OAuth
// connect flow (B1) — the .env vars are just the Google OAuth
// client credentials needed to refresh expired access tokens.
//
// Flow per send:
//   1. Look up the OAuthAccount for this (provider="google", teamId).
//      B2 wires the office-wide slot (teamId=null); per-team
//      routing lands in B3.
//   2. Decrypt the stored access token, or refresh if near-expiry
//      (getFreshAccessToken handles the dance + re-encryption +
//      persistence).
//   3. Build the raw RFC 5322 message with the connected
//      googleEmail as the From (Gmail 400s on From != authenticated
//      user unless a verified send-as alias is configured; we keep
//      it simple for B2 and always send AS the connected address).
//   4. POST to users.messages.send.
//   5. Map the response:
//        200 OK with body.id  -> ok + providerId
//        401 Unauthorized     -> token revoked at Google (rare here
//                                because step 2 gave us a fresh one,
//                                but possible if the user revoked
//                                between refresh and send). Audit
//                                as `oauth.google.revoked`. Non-
//                                retryable — retrying won't help.
//        403 Forbidden        -> usually scope insufficient or
//                                send quota exceeded. Non-retryable
//                                because both cases require admin
//                                intervention, not a resend.
//        429 Too Many Requests -> rate limit. Retryable.
//        5xx                  -> Google-side. Retryable.
//        Any other            -> non-retryable with the error body.
//   6. TokenRevokedError from step 2 is treated the same as 401 but
//      short-circuits before the network call.
//
// Factory-level deliberately DOES NOT take apiKey-style creds —
// Gmail auth is per-mailbox and lives in Postgres, not env. The
// factory takes OAuth client creds (to refresh tokens) and an
// optional team scope.

export interface GmailProviderOptions {
  clientId: string;
  clientSecret: string;
  // null = office-wide mailbox (the default for B2). B3 will wire
  // per-campaign selection so the caller can target a specific team.
  teamId?: string | null;
  // Optional display-name override. Gmail ignores this for From
  // (it uses the account's configured display name) but we pass it
  // through so internal audits and bounced-message envelopes
  // reference a consistent name.
  fromName?: string;
}

export function gmail(opts: GmailProviderOptions): EmailProvider {
  const teamId = opts.teamId ?? null;
  return {
    name: "gmail",
    async send(msg: EmailMessage): Promise<SendResult> {
      // Look up the connected mailbox. No row = nobody clicked
      // Connect yet, or the last connection was revoked and the row
      // deleted. Fail closed with a clear message so the send
      // pipeline's retry logic doesn't loop on a config gap.
      //
      // The orderBy is load-bearing, not cosmetic: Postgres treats
      // NULLs as DISTINCT in the `@@unique([provider, teamId])`
      // constraint, so two concurrent admin connects on the
      // office-wide slot (teamId=null) can leave duplicate rows in
      // the table. Without an explicit order, `findFirst` could pick
      // a stale older row and we'd send from the wrong mailbox or
      // with a revoked refresh_token even though a newer valid
      // connection exists. `updatedAt desc` means:
      //   - a fresh reconnect always wins over an older duplicate
      //     (because /callback's upsert bumps updatedAt on the row
      //     it writes, and the cleanup deleteMany removes losers on
      //     the same commit);
      //   - token refreshes tick updatedAt too, so once we start
      //     using a row it stays the winner across its TTL.
      // `createdAt desc` / `id desc` are tiebreakers for the
      // pathological case where two rows share an updatedAt (can
      // happen if cleanup fails partway for some reason — we'd
      // rather be deterministic than coin-flip).
      const account = await prisma.oAuthAccount.findFirst({
        where: { provider: "google", teamId },
        orderBy: [
          { updatedAt: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
      });
      if (!account) {
        return {
          ok: false,
          error: `gmail provider: no OAuthAccount for teamId=${teamId ?? "<office-wide>"}; admin must connect Gmail at /settings`,
          retryable: false,
        };
      }

      // Refresh-if-needed. Errors here are fatal to this send but
      // may be retryable (network) or not (revoked).
      let accessToken: string;
      let refreshed = false;
      try {
        const r = await getFreshAccessToken({
          account: {
            id: account.id,
            accessTokenEnc: account.accessTokenEnc,
            refreshTokenEnc: account.refreshTokenEnc,
            tokenExpiresAt: account.tokenExpiresAt,
          },
          clientId: opts.clientId,
          clientSecret: opts.clientSecret,
          onRefresh: async (u) => {
            await prisma.oAuthAccount.update({
              where: { id: u.accountId },
              data: {
                accessTokenEnc: u.accessTokenEnc,
                tokenExpiresAt: u.tokenExpiresAt,
              },
            });
          },
        });
        accessToken = r.accessToken;
        refreshed = r.refreshed;
      } catch (e) {
        if (e instanceof TokenRevokedError) {
          await logAction({
            kind: "oauth.google.revoked",
            refType: "oauthAccount",
            refId: account.id,
            data: {
              teamId,
              googleEmail: account.googleEmail,
              source: "refresh_invalid_grant",
            },
          });
          return {
            ok: false,
            error: `gmail token revoked for ${account.googleEmail}; admin must reconnect`,
            retryable: false,
          };
        }
        // Network / 5xx / config. Retryable — the caller's backoff
        // loop gets another shot.
        return {
          ok: false,
          error: `gmail refresh failed: ${String(e).slice(0, 200)}`,
          retryable: true,
        };
      }

      if (refreshed) {
        // Best-effort audit. logAction swallows its own errors so
        // this never breaks the send.
        await logAction({
          kind: "oauth.google.refreshed",
          refType: "oauthAccount",
          refId: account.id,
          data: { teamId, googleEmail: account.googleEmail },
        });
      }

      // Build the raw message. The MIME builder may throw on CR/LF
      // injection in headers — map to non-retryable, because
      // retrying with the same payload won't help.
      let raw: string;
      try {
        raw = buildRawMessage({
          from: account.googleEmail,
          fromName: opts.fromName,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          replyTo: msg.replyTo,
          headers: msg.headers,
        });
      } catch (e) {
        return {
          ok: false,
          error: `gmail build failed: ${String(e).slice(0, 200)}`,
          retryable: false,
        };
      }

      // Send.
      const res = await fetch(GMAIL_SEND_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ raw }),
      });

      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { id?: string };
        return { ok: true, providerId: body.id ?? "gmail_unknown" };
      }

      // Read the error body once, use it for both the audit and
      // the returned error message.
      const errText = await res.text().catch(() => "");
      const errSnippet = errText.slice(0, 300);

      if (res.status === 401) {
        // Revoked between refresh and send. Rare but possible.
        await logAction({
          kind: "oauth.google.revoked",
          refType: "oauthAccount",
          refId: account.id,
          data: {
            teamId,
            googleEmail: account.googleEmail,
            source: "send_401",
            body: errSnippet,
          },
        });
        return {
          ok: false,
          error: `gmail 401: token revoked; admin must reconnect`,
          retryable: false,
        };
      }

      if (res.status === 403) {
        // Scope-insufficient or quota-exceeded. Neither is fixed by
        // a retry — both need an admin.
        return {
          ok: false,
          error: `gmail 403: ${errSnippet}`,
          retryable: false,
        };
      }

      if (res.status === 429 || res.status >= 500) {
        return {
          ok: false,
          error: `gmail ${res.status}: ${errSnippet}`,
          retryable: true,
        };
      }

      return {
        ok: false,
        error: `gmail ${res.status}: ${errSnippet}`,
        retryable: false,
      };
    },
  };
}
