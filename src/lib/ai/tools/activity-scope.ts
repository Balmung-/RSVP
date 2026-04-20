import type { Prisma } from "@prisma/client";

// Pure derivation of the EventLog `where` filter that
// `campaign_detail.ts` uses to pull activity rows for a single
// campaign. Extracted so the OR-composition rules — always-include
// campaign branch + conditional stage branch + conditional invitee
// branch + single-entry collapse + capped-scan flag — are unit-
// testable without prisma / `campaignStats` / the handler envelope.
//
// Why this needs its own helper:
//
//   1. Dropping the stage branch on a single-stage campaign was the
//      exact regression Push 6a flagged — `invite.sent` and `stage.*`
//      rows use `refType: "stage"` with a stage.id, not the campaign
//      id, so a campaign-only filter makes them invisible on the
//      detail card. The helper pins the "emit stage branch iff
//      stageIds.length > 0" rule so that regression can't silently
//      return.
//
//   2. The single-entry collapse (`scopedOr.length === 1 ? scopedOr[0]
//      : { OR: scopedOr }`) is a query-plan optimization: Prisma /
//      Postgres plan a bare `{refType, refId}` differently from an
//      `OR` of one. Collapse must trigger EXACTLY when there is one
//      branch — neither "always OR-wrap" (kills the plan) nor "always
//      collapse" (can only return one row-shape). Pinned here so
//      re-ordering the conditional pushes never break the threshold.
//
//   3. `inviteeIds: string[] | null` uses `null` as the sentinel for
//      "scan was skipped because the campaign is over the 2000-
//      invitee cap" — distinct from `[]` which means "scan ran, no
//      matches". `inviteeScanCapped` flips ONLY on the null sentinel,
//      not on empty array. This is the contract the card UI relies on
//      to paint the "per-invitee events hidden" hint; pinning the
//      distinction keeps callers from conflating the two.
//
//   4. Branch ORDER (campaign → stage → invitee) is not a semantic
//      property of OR — it's commutative — but it IS a property of
//      the query plan Prisma emits, and of the audit stream that
//      replays `activityWhere` on backfills. Pinning order means a
//      well-meaning "alphabetize the branches" cleanup gets caught.
//
// Mirror copy — the canonical campaign activity page
// (`src/app/campaigns/[id]/activity/page.tsx:60-68`) has a near-
// identical inline copy of this composition, including the same
// collapse rule and the same capped flag. That duplication predates
// this helper; a future slice can migrate the activity page to call
// `deriveActivityScope` once the pins here have proven themselves.
// Until then, any drift between the two call sites is a regression
// these tests will NOT catch (they only guard the campaign_detail
// path). Recorded here so a reader who breaks the activity-page
// copy knows to look for this helper, and so the follow-up is
// self-documenting.

export type DeriveActivityScopeInput = {
  // The campaign whose activity rows we're filtering. Used verbatim
  // as the `refId` of the campaign branch; caller guarantees this
  // is an already-scope-checked id (handler has already AND-composed
  // ctx.campaignScope with the id before loading the campaign row).
  campaignId: string;

  // Rows returned by `prisma.campaignStage.findMany({..., select: { id: true }})`.
  // We accept the object shape (not already-mapped strings) so the
  // call site doesn't have to do the `.map((s) => s.id)` itself —
  // keeps the helper signature a drop-in replacement for the inline
  // composition, and keeps the "we extract .id from each row" rule
  // testable here.
  stageIds: Array<{ id: string }>;

  // Invitee-id set for the campaign, OR `null` if the invitee scan
  // was skipped due to the 2000-cap. The null sentinel is load-
  // bearing: it both (a) suppresses the invitee branch and (b)
  // flips `inviteeScanCapped` to true. `[]` (scan ran, no invitees)
  // also suppresses the branch but leaves the flag false. Callers
  // MUST NOT pass `[]` when they mean "capped" — that would silently
  // disable the UI hint.
  inviteeIds: string[] | null;
};

export type DeriveActivityScopeResult = {
  // The fully-composed `where` clause ready to pass to
  // `prisma.eventLog.findMany`. When only the campaign branch is
  // active (no stages, no invitees) this is a bare
  // `{refType, refId}` literal — no OR wrapper, so Prisma can plan
  // against the (refType, refId, createdAt) composite index
  // directly. Otherwise it's `{ OR: [...] }` with the active
  // branches.
  activityWhere: Prisma.EventLogWhereInput;

  // True iff the caller passed `inviteeIds: null`, signaling the
  // scan was capped. The card's `invitee_scan_capped: true` output
  // field surfaces this so the UI can render the "per-invitee
  // events hidden" hint. Pinned distinct from the empty-array case.
  inviteeScanCapped: boolean;
};

export function deriveActivityScope(
  input: DeriveActivityScopeInput,
): DeriveActivityScopeResult {
  const { campaignId, stageIds, inviteeIds } = input;

  // Branches are built in deterministic order (campaign → stage →
  // invitee) so the emitted OR array has a stable shape. Order is
  // not semantically meaningful (OR is commutative) but it IS
  // observable — by the audit replay stream, by snapshot tests that
  // diff the rendered where-clause, and by operators reading the
  // query log. Pinned.
  const scopedOr: Prisma.EventLogWhereInput[] = [
    { refType: "campaign", refId: campaignId },
    ...(stageIds.length > 0
      ? [
          {
            refType: "stage",
            refId: { in: stageIds.map((s) => s.id) },
          } as Prisma.EventLogWhereInput,
        ]
      : []),
    ...(inviteeIds && inviteeIds.length > 0
      ? [
          {
            refType: "invitee",
            refId: { in: inviteeIds },
          } as Prisma.EventLogWhereInput,
        ]
      : []),
  ];

  // Single-entry collapse — when the campaign branch is the only
  // branch (no stages, no invitees), emit it bare so Prisma plans
  // the simple index path. Wrapping a single branch in `OR` forces
  // Postgres to consider the OR plan space for no benefit.
  const activityWhere: Prisma.EventLogWhereInput =
    scopedOr.length === 1 ? scopedOr[0] : { OR: scopedOr };

  return {
    activityWhere,
    // `null` sentinel → capped. Empty array → NOT capped (scan ran
    // and legitimately found zero invitees — rare for a non-cap
    // campaign but possible for one mid-creation). Keeping the two
    // cases distinct matters because the UI hint "campaign is too
    // large, per-invitee rows hidden" is misleading if shown for an
    // actual-empty campaign.
    inviteeScanCapped: inviteeIds === null,
  };
}
