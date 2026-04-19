// Pure account-routing helper for the Gmail adapter (B3).
//
// Given a target teamId and a Prisma accessor, pick the best
// OAuthAccount row to send from:
//
//   1. targetTeamId is a string (per-campaign send):
//        - Try the team-scoped row first. Hit -> team_hit.
//        - Miss -> fall back to the office-wide (teamId=null) row.
//          Hit -> team_miss_fallback_office (audit-worthy).
//          Miss -> no_account.
//   2. targetTeamId is null (office-wide send, or campaign with
//      teamId=null):
//        - Try the office-wide row. Hit -> office_hit. Miss -> no_account.
//
// The team -> office-wide fallback is deliberate. A campaign tagged
// with teamId=X can pre-date the day an admin connected team X's
// dedicated mailbox: before B3, every send for X used the office-wide
// mailbox anyway, so the least-surprising behavior when a team row is
// missing is to keep doing that. The alternative — fail the send —
// would turn B3 from "enhance routing" into "break every existing
// team campaign whose admin hasn't migrated yet." The fallback is
// audited via `gmail.routing.fallback` so operators can tell
// "intentional office-wide" from "accidentally using office-wide
// because team mailbox isn't connected yet."
//
// Pure: no Prisma import, no logging, no side effects. The caller
// injects a `findFirst(teamId)` callback — this keeps the resolver
// trivially testable with an in-memory stub (see
// tests/unit/gmail-resolve.test.ts) and sidesteps needing a DB for
// unit coverage of the routing decision tree.

export type MinimalAccountRow = {
  id: string;
  teamId: string | null;
  googleEmail: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  // Non-null in Prisma schema: every connected account has an expiry
  // (callback seeds it as `now + expires_in - 60`, refresh updates it).
  // Keeping the type strict here means a future schema drift to
  // nullable would surface as a TS error at the getFreshAccessToken
  // callsite in gmail.ts, not silently degrade.
  tokenExpiresAt: Date;
};

export type ResolveRouting =
  | { kind: "team_hit"; teamId: string }
  | { kind: "team_miss_fallback_office"; requestedTeamId: string }
  | { kind: "office_hit" }
  | { kind: "no_account"; requestedTeamId: string | null };

export interface ResolveResult {
  account: MinimalAccountRow | null;
  routing: ResolveRouting;
}

export async function resolveGmailAccount(params: {
  targetTeamId: string | null;
  findFirst: (teamId: string | null) => Promise<MinimalAccountRow | null>;
}): Promise<ResolveResult> {
  const { targetTeamId, findFirst } = params;

  if (targetTeamId !== null) {
    const teamRow = await findFirst(targetTeamId);
    if (teamRow) {
      return {
        account: teamRow,
        routing: { kind: "team_hit", teamId: targetTeamId },
      };
    }
    // Team row missing — fall back to office-wide.
    const officeRow = await findFirst(null);
    if (officeRow) {
      return {
        account: officeRow,
        routing: {
          kind: "team_miss_fallback_office",
          requestedTeamId: targetTeamId,
        },
      };
    }
    return {
      account: null,
      routing: { kind: "no_account", requestedTeamId: targetTeamId },
    };
  }

  // Office-wide request — no fallback chain, just the one lookup.
  const officeRow = await findFirst(null);
  if (officeRow) {
    return { account: officeRow, routing: { kind: "office_hit" } };
  }
  return {
    account: null,
    routing: { kind: "no_account", requestedTeamId: null },
  };
}
