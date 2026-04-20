import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

import { deriveActivityScope } from "../../src/lib/ai/tools/activity-scope";

// P14-G pin set. The helper being tested lives in
// `src/lib/ai/tools/activity-scope.ts` and encapsulates the four
// rules `campaign_detail.ts` used to inline before extraction:
//
//   (a) always emit a "campaign" branch for the input campaignId;
//   (b) emit a "stage" branch iff stageIds is non-empty, using
//       `{in: [...]}` even for single-element stage sets;
//   (c) emit an "invitee" branch iff inviteeIds is a non-empty
//       array (null or empty → no branch);
//   (d) collapse to a bare branch literal when only one branch
//       exists; otherwise wrap in `{ OR: [...] }`;
//   (e) set `inviteeScanCapped` iff inviteeIds === null (not empty
//       array).
//
// These pins lock in each rule independently. The helper is used
// by the `campaign_detail` AI tool to filter EventLog rows for a
// single campaign; a regression in any of these rules either drops
// legitimate activity rows off the operator-visible card (breaking
// the Push 6a stage-sends fix) OR shows a misleading "campaign is
// large" hint on a non-capped small campaign.
//
// A near-identical copy of the composition still lives inline at
// `src/app/campaigns/[id]/activity/page.tsx:60-68`. These pins do
// NOT guard that copy — the page has its own call site and would
// need its own test or migration to `deriveActivityScope`. Noted
// here so a reader who touches the page knows the pins here don't
// extend there.

// Tiny narrowing helper — when we assert `.OR` we need TS to accept
// that the value is the OR-wrapped variant. Prisma's
// EventLogWhereInput is a fat union, so we use a cast after an
// `in` check at runtime.
function asOr(
  w: Prisma.EventLogWhereInput,
): Prisma.EventLogWhereInput[] {
  assert.ok("OR" in w, "expected { OR: [...] } branch, got a bare branch");
  const or = (w as { OR: Prisma.EventLogWhereInput[] }).OR;
  assert.ok(Array.isArray(or), "OR must be an array");
  return or;
}

// ---------------------------------------------------------------
// (1) Campaign-only scope: no stages, no invitees.
//     This is the single-entry collapse case — the helper MUST
//     return a bare `{refType, refId}` literal, NOT wrap it in
//     `{ OR: [...] }`. Collapse exists so Prisma plans the
//     composite-index path directly; wrapping a one-branch OR
//     forces the planner to consider the disjunction space for
//     no benefit. Regression: "always-OR-wrap" cleanup would
//     quietly break the planner optimization without changing
//     visible results.
// ---------------------------------------------------------------
test("campaign-only scope → bare branch, no OR wrapper", () => {
  const { activityWhere, inviteeScanCapped } = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [],
    inviteeIds: [],
  });
  // No OR wrapper. Direct refType+refId literal.
  assert.equal("OR" in activityWhere, false);
  assert.deepEqual(activityWhere, { refType: "campaign", refId: "cmp_abc" });
  // Empty array ≠ capped.
  assert.equal(inviteeScanCapped, false);
});

// ---------------------------------------------------------------
// (2) Campaign + stages: 2-entry OR. Stage branch uses
//     `{in: [...]}` with the extracted .id strings.
// ---------------------------------------------------------------
test("campaign + stages → { OR: [campaign, stage] }", () => {
  const { activityWhere, inviteeScanCapped } = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [{ id: "stg_1" }, { id: "stg_2" }],
    inviteeIds: [],
  });
  const or = asOr(activityWhere);
  assert.equal(or.length, 2);
  assert.deepEqual(or[0], { refType: "campaign", refId: "cmp_abc" });
  assert.deepEqual(or[1], {
    refType: "stage",
    refId: { in: ["stg_1", "stg_2"] },
  });
  assert.equal(inviteeScanCapped, false);
});

// ---------------------------------------------------------------
// (3) Campaign + invitees (scan ran): 2-entry OR. inviteeScanCapped
//     is FALSE because inviteeIds was a non-null array.
// ---------------------------------------------------------------
test("campaign + invitees → { OR: [campaign, invitee] } + capped=false", () => {
  const { activityWhere, inviteeScanCapped } = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [],
    inviteeIds: ["inv_1", "inv_2", "inv_3"],
  });
  const or = asOr(activityWhere);
  assert.equal(or.length, 2);
  assert.deepEqual(or[0], { refType: "campaign", refId: "cmp_abc" });
  assert.deepEqual(or[1], {
    refType: "invitee",
    refId: { in: ["inv_1", "inv_2", "inv_3"] },
  });
  assert.equal(inviteeScanCapped, false);
});

// ---------------------------------------------------------------
// (4) Campaign + stages + invitees: 3-entry OR. Order is
//     campaign → stage → invitee (NOT alphabetical, NOT any
//     other order). The order is implementation-specific but
//     pinned because a well-meaning "alphabetize the branches"
//     cleanup would reorder them invisibly to semantics yet
//     observably to the audit stream / query plan.
// ---------------------------------------------------------------
test("all three branches → { OR: [campaign, stage, invitee] } in that order", () => {
  const { activityWhere } = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [{ id: "stg_1" }],
    inviteeIds: ["inv_1"],
  });
  const or = asOr(activityWhere);
  assert.equal(or.length, 3);
  // Exact order pinned.
  assert.deepEqual(or[0], { refType: "campaign", refId: "cmp_abc" });
  assert.deepEqual(or[1], { refType: "stage", refId: { in: ["stg_1"] } });
  assert.deepEqual(or[2], { refType: "invitee", refId: { in: ["inv_1"] } });
});

// ---------------------------------------------------------------
// (5) Capped invitee scan (inviteeIds === null): flag flips to
//     true, invitee branch is NOT emitted. Shape collapses to
//     the campaign-only bare branch because the null suppresses
//     the invitee branch entirely.
// ---------------------------------------------------------------
test("capped invitee scan (null) → flag=true, no invitee branch", () => {
  const { activityWhere, inviteeScanCapped } = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [],
    inviteeIds: null,
  });
  assert.equal(inviteeScanCapped, true);
  // Only campaign branch active → collapse to bare literal.
  assert.equal("OR" in activityWhere, false);
  assert.deepEqual(activityWhere, { refType: "campaign", refId: "cmp_abc" });
});

// ---------------------------------------------------------------
// (6) Capped scan + stages present: invitee branch suppressed
//     by null, but stage branch is emitted → 2-entry OR. The
//     capped flag is still true.
// ---------------------------------------------------------------
test("capped scan + stages → { OR: [campaign, stage] } + flag=true", () => {
  const { activityWhere, inviteeScanCapped } = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [{ id: "stg_1" }, { id: "stg_2" }],
    inviteeIds: null,
  });
  const or = asOr(activityWhere);
  assert.equal(or.length, 2);
  assert.deepEqual(or[0], { refType: "campaign", refId: "cmp_abc" });
  assert.deepEqual(or[1], {
    refType: "stage",
    refId: { in: ["stg_1", "stg_2"] },
  });
  assert.equal(inviteeScanCapped, true);
});

// ---------------------------------------------------------------
// (7) SAFETY PIN — empty array vs null differ in their effect on
//     `inviteeScanCapped`. Both suppress the invitee branch (same
//     shape from the query side), but the UI hint "per-invitee
//     events hidden" only makes sense for the null case. Pinning
//     this distinction guards against a well-meaning "normalize
//     null → []" refactor that would silently disable the hint.
// ---------------------------------------------------------------
test("null vs [] for inviteeIds — same where shape, different flag", () => {
  const capped = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [],
    inviteeIds: null,
  });
  const empty = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [],
    inviteeIds: [],
  });
  // Same activityWhere — both collapse to the bare campaign branch.
  assert.deepEqual(capped.activityWhere, empty.activityWhere);
  // Flag differs.
  assert.equal(capped.inviteeScanCapped, true);
  assert.equal(empty.inviteeScanCapped, false);
});

// ---------------------------------------------------------------
// (8) Single-stage campaign still uses `{in: [id]}` — NOT a bare
//     scalar `refId: stageId`. Prisma accepts either form, but
//     the composition is consistent: stage branch ALWAYS uses
//     the IN filter. A regression "optimize singletons to scalar"
//     would pass smoke tests but diverge from the activity page's
//     shape and confuse any downstream code diffing where-clauses.
// ---------------------------------------------------------------
test("single-stage campaign uses { in: [id] }, not bare scalar", () => {
  const { activityWhere } = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [{ id: "stg_lone" }],
    inviteeIds: [],
  });
  const or = asOr(activityWhere);
  assert.equal(or.length, 2);
  // Stage branch: refId is { in: [...] }, not a bare string.
  const stageBranch = or[1] as { refType: string; refId: { in: string[] } };
  assert.equal(stageBranch.refType, "stage");
  assert.deepEqual(stageBranch.refId, { in: ["stg_lone"] });
  // Explicitly NOT a bare string.
  assert.notEqual(typeof (stageBranch as { refId: unknown }).refId, "string");
});

// ---------------------------------------------------------------
// (9) Single-invitee campaign uses `{in: [id]}` — same discipline
//     as single-stage. Guards against the same "optimize singleton
//     to scalar" regression for the invitee branch specifically.
// ---------------------------------------------------------------
test("single-invitee campaign uses { in: [id] }, not bare scalar", () => {
  const { activityWhere } = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [],
    inviteeIds: ["inv_lone"],
  });
  const or = asOr(activityWhere);
  assert.equal(or.length, 2);
  const invBranch = or[1] as { refType: string; refId: { in: string[] } };
  assert.equal(invBranch.refType, "invitee");
  assert.deepEqual(invBranch.refId, { in: ["inv_lone"] });
});

// ---------------------------------------------------------------
// (10) `.map((s) => s.id)` discipline — the helper extracts the
//      `.id` field from each stage input object, NOT the whole
//      object. Pinning this catches a regression that either
//      forgets the `.map` or uses the wrong property name.
// ---------------------------------------------------------------
test("stageIds input: only .id field used, object not passed through", () => {
  // Deliberately include extra fields on the input — helper must
  // ignore them.
  const { activityWhere } = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [
      { id: "stg_1", name: "ignored", extra: 42 } as { id: string },
      { id: "stg_2", name: "also ignored", extra: 99 } as { id: string },
    ],
    inviteeIds: [],
  });
  const or = asOr(activityWhere);
  const stageBranch = or[1] as { refId: { in: string[] } };
  // Extracts .id cleanly; no spurious fields.
  assert.deepEqual(stageBranch.refId, { in: ["stg_1", "stg_2"] });
  // The entries are plain strings, not objects.
  for (const entry of stageBranch.refId.in) {
    assert.equal(typeof entry, "string");
  }
});

// ---------------------------------------------------------------
// (11) campaignId propagates verbatim into the campaign branch's
//      refId. Pins the "we don't accidentally mangle the id" case
//      (e.g. trimming, lowercasing, prefix-stripping). Prisma ids
//      are case-sensitive.
// ---------------------------------------------------------------
test("campaignId propagates verbatim to campaign branch refId", () => {
  const weirdId = "cmp_Abc123_MiXeD_cAsE";
  const { activityWhere } = deriveActivityScope({
    campaignId: weirdId,
    stageIds: [],
    inviteeIds: [],
  });
  assert.deepEqual(activityWhere, { refType: "campaign", refId: weirdId });
});

// ---------------------------------------------------------------
// (12) refType literal strings — pin the EXACT strings "campaign",
//      "stage", "invitee" so a silent rename ("event" → "ev") in
//      one place would flunk. These values are the contract with
//      EventLog.refType across writes from stages.ts / inbound.ts /
//      checkin.ts / etc. Drift here breaks EVERY reader.
// ---------------------------------------------------------------
test("refType strings: campaign / stage / invitee — exact literals", () => {
  const { activityWhere } = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [{ id: "stg_1" }],
    inviteeIds: ["inv_1"],
  });
  const or = asOr(activityWhere);
  const refTypes = or.map((b) => (b as { refType: string }).refType);
  assert.deepEqual(refTypes, ["campaign", "stage", "invitee"]);
});

// ---------------------------------------------------------------
// (13) Output-shape drift guard — result has EXACTLY two keys.
//      If a future version adds (say) an `estimatedRowCount` field,
//      this test flunks — the caller (`campaign_detail.ts`) only
//      destructures these two, and a silent extension without
//      rewiring the caller would drop the new field.
// ---------------------------------------------------------------
test("result shape: exactly { activityWhere, inviteeScanCapped } — no extra keys", () => {
  const result = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [],
    inviteeIds: [],
  });
  const keys = Object.keys(result).sort();
  assert.deepEqual(keys, ["activityWhere", "inviteeScanCapped"]);
});

// ---------------------------------------------------------------
// (14) COLLAPSE THRESHOLD — the single-entry collapse MUST trigger
//      at exactly length === 1. At length === 2 the OR wrapper is
//      ALWAYS emitted. This is the threshold the inline version
//      got right (`scopedOr.length === 1 ? scopedOr[0] : { OR: ... }`)
//      and a regression ">= 1 collapse" would return the bare
//      campaign branch on a multi-branch query, silently dropping
//      stage/invitee rows. Deadliest possible regression.
// ---------------------------------------------------------------
test("collapse threshold: 1 branch → bare; 2 branches → OR wrapper", () => {
  // One branch → bare (campaign-only)
  const one = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [],
    inviteeIds: [],
  });
  assert.equal("OR" in one.activityWhere, false);

  // Two branches (campaign + stage) → OR wrapper
  const two = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [{ id: "stg_1" }],
    inviteeIds: [],
  });
  assert.equal("OR" in two.activityWhere, true);
  assert.equal(asOr(two.activityWhere).length, 2);

  // Two branches (campaign + invitee, no stage) → OR wrapper
  const twoAlt = deriveActivityScope({
    campaignId: "cmp_abc",
    stageIds: [],
    inviteeIds: ["inv_1"],
  });
  assert.equal("OR" in twoAlt.activityWhere, true);
  assert.equal(asOr(twoAlt.activityWhere).length, 2);
});
