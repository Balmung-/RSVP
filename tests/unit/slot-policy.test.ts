import { test } from "node:test";
import assert from "node:assert/strict";

import { SLOT_COMPOSITION, SLOT_POLICY } from "../../src/lib/ai/slotPolicy";
import {
  validateWidget,
  WIDGET_KINDS,
  WIDGET_SLOTS,
} from "../../src/lib/ai/widget-validate";

// P8 — slot policy tests.
//
// Two layers:
//   1. Table-level invariants. SLOT_POLICY and SLOT_COMPOSITION each
//      have to cover their full domain (every WidgetKind has a slot,
//      every WidgetSlot has a composition mode). The `satisfies`
//      clauses in slotPolicy.ts catch the compile-time case; these
//      tests are the belt-and-suspenders runtime assertion so a
//      drift after a type cast / stray `as const` isn't silent.
//   2. Validator enforcement. `validateWidget` rejects a kind+slot
//      combination the policy forbids — BEFORE the DB upsert, BEFORE
//      the eviction logic. If this regressed, a tool that declared
//      the wrong slot could still write the row; the eviction
//      downstream would then consider it a legitimate occupant and
//      start incorrectly evicting real occupants of that slot.
//
// The tests deliberately exercise both a few specific mappings AND
// the coverage sweep, because either one alone misses a regression:
// a coverage sweep passes if a single typo flips e.g. `primary` to
// `secondary`, and a spot-check misses a newly-added kind that never
// got a policy entry.

// ---- table coverage ----

test("SLOT_POLICY has an entry for every WidgetKind", () => {
  // Exhaustiveness guarantee: adding a new kind to WIDGET_KINDS
  // without adding to SLOT_POLICY trips this. The `satisfies`
  // clause already enforces this at compile time, but a runtime
  // test catches any drift introduced via unsafe casts.
  for (const kind of WIDGET_KINDS) {
    assert.ok(
      SLOT_POLICY[kind],
      `SLOT_POLICY missing entry for kind "${kind}"`,
    );
  }
  // Same count on both sides — no policy entry for a removed kind.
  assert.equal(Object.keys(SLOT_POLICY).length, WIDGET_KINDS.length);
});

test("SLOT_COMPOSITION has an entry for every WidgetSlot", () => {
  for (const slot of WIDGET_SLOTS) {
    assert.ok(
      SLOT_COMPOSITION[slot],
      `SLOT_COMPOSITION missing entry for slot "${slot}"`,
    );
  }
  assert.equal(Object.keys(SLOT_COMPOSITION).length, WIDGET_SLOTS.length);
});

test("SLOT_POLICY maps every kind to a slot that SLOT_COMPOSITION recognises", () => {
  // Defence-in-depth — the `satisfies Record<WidgetKind, WidgetSlot>`
  // ensures each slot IS a WidgetSlot, and the coverage test above
  // ensures every WidgetSlot has a composition entry; this chains
  // the two so a typo-after-cast can't leave a kind pointing at a
  // slot that has no composition rule.
  for (const kind of WIDGET_KINDS) {
    const slot = SLOT_POLICY[kind];
    assert.ok(
      slot in SLOT_COMPOSITION,
      `kind "${kind}" maps to slot "${slot}" which has no SLOT_COMPOSITION entry`,
    );
  }
});

// ---- composition mode distribution ----

test("SLOT_COMPOSITION: summary/primary/secondary are singleton-per-slot", () => {
  // Pinning the three singleton slots explicitly. A design change
  // that loosens secondary (say file_digests coexist) would have to
  // visibly update THIS test — grep-auditable so a reviewer sees
  // the composition shift rather than catching it from a test name.
  assert.equal(SLOT_COMPOSITION.summary, "singleton-per-slot");
  assert.equal(SLOT_COMPOSITION.primary, "singleton-per-slot");
  assert.equal(SLOT_COMPOSITION.secondary, "singleton-per-slot");
});

test("SLOT_COMPOSITION: action is coexist-per-key", () => {
  // The action slot is the ONLY coexist-per-key slot today. If a
  // future design changes this (single confirm-at-a-time), THIS is
  // the line that has to flip — forces the reviewer to think about
  // the operator workflow implications of stacked-vs-sequential
  // confirms.
  assert.equal(SLOT_COMPOSITION.action, "coexist-per-key");
});

// ---- specific kind-slot pins ----

test("SLOT_POLICY: workspace_rollup lives in summary", () => {
  // One and only one kind lives in summary. Moving it elsewhere
  // would strand the rollup's static widgetKey under a slot it
  // doesn't match, and the eviction logic would start churning it
  // out every time a peer widget wrote to summary.
  assert.equal(SLOT_POLICY.workspace_rollup, "summary");
});

test("SLOT_POLICY: hero kinds (campaign_list / card / contact_table / import_review) all map to primary", () => {
  // These are the "hero" views — exactly one of them is active at
  // a time per session. Singleton-per-slot + same-slot means a
  // pivot from list -> card evicts the list (and vice versa), which
  // is the operator-visible UX the policy is built to deliver.
  assert.equal(SLOT_POLICY.campaign_list, "primary");
  assert.equal(SLOT_POLICY.campaign_card, "primary");
  assert.equal(SLOT_POLICY.contact_table, "primary");
  assert.equal(SLOT_POLICY.import_review, "primary");
});

test("SLOT_POLICY: context kinds (activity_stream / file_digest) map to secondary", () => {
  // Both sit next to the hero card. Re-asking for activity evicts
  // the prior feed; re-summarising a different file evicts the
  // prior digest. Same policy posture as `primary`.
  assert.equal(SLOT_POLICY.activity_stream, "secondary");
  assert.equal(SLOT_POLICY.file_digest, "secondary");
});

test("SLOT_POLICY: confirm kinds (draft / send / import) all map to action", () => {
  // Stacked confirms — the operator can have multiple pending
  // confirms in flight at once. Any policy change that singleton-ed
  // this slot would wipe an in-progress confirm when a new one
  // emits, which is strictly worse than the current behaviour.
  assert.equal(SLOT_POLICY.confirm_draft, "action");
  assert.equal(SLOT_POLICY.confirm_send, "action");
  assert.equal(SLOT_POLICY.confirm_import, "action");
});

// ---- validator enforcement ----
//
// Pre-P8 the validator rejected unknown kinds / unknown slots but
// accepted ANY known (kind, slot) pair. P8 tightens that: each kind
// has ONE legal slot per `SLOT_POLICY`, and any other pairing is
// rejected AT THE VALIDATOR BOUNDARY. Downstream code (upsertWidget,
// the eviction loop, the client reducer) relies on this invariant;
// if the validator ever regressed here, a mis-slotted row would be
// persisted and the eviction logic would start treating it as a
// legitimate slot occupant.

// Minimal valid props per kind — just enough to pass each per-kind
// prop validator. Reused across the mismatch tests so any drift in
// those validators surfaces here immediately.
const validCampaignListProps = { items: [] };
const validActivityStreamProps = { items: [] };
const validConfirmDraftProps = {
  id: "c",
  name: "",
  description: null,
  venue: null,
  event_at: null,
  locale: "",
  status: "",
  team_id: null,
  created_at: "",
  state: "done" as const,
};

test("validateWidget: accepts campaign_list in primary (policy-allowed)", () => {
  // Spot-check of the allow path — each of the three pass cases
  // below (primary / secondary / action kind) uses a different kind
  // so a regression in just one branch still gets caught.
  const out = validateWidget({
    widgetKey: "k",
    kind: "campaign_list",
    slot: "primary",
    props: validCampaignListProps,
  });
  assert.ok(out);
  assert.equal(out?.slot, "primary");
});

test("validateWidget: accepts activity_stream in secondary (policy-allowed)", () => {
  const out = validateWidget({
    widgetKey: "k",
    kind: "activity_stream",
    slot: "secondary",
    props: validActivityStreamProps,
  });
  assert.ok(out);
  assert.equal(out?.slot, "secondary");
});

test("validateWidget: accepts confirm_draft in action (policy-allowed)", () => {
  const out = validateWidget({
    widgetKey: "k",
    kind: "confirm_draft",
    slot: "action",
    props: validConfirmDraftProps,
  });
  assert.ok(out);
  assert.equal(out?.slot, "action");
});

test("validateWidget: rejects campaign_list in action (hero kind, wrong slot)", () => {
  // The most operator-visible regression: a list card landing in
  // the confirm slot would leave a destructive-looking empty action
  // button with no anchoring confirm. The policy puts it in primary;
  // the validator enforces that here.
  const out = validateWidget({
    widgetKey: "k",
    kind: "campaign_list",
    slot: "action",
    props: validCampaignListProps,
  });
  assert.equal(out, null);
});

test("validateWidget: rejects confirm_draft in primary (action kind, wrong slot)", () => {
  // Inverse direction — confirm card trying to sit in the hero
  // slot. A bug that let this through would blank the primary view
  // behind an action card, and singleton-per-slot would start
  // evicting legitimate primary occupants as soon as any confirm
  // fired.
  const out = validateWidget({
    widgetKey: "k",
    kind: "confirm_draft",
    slot: "primary",
    props: validConfirmDraftProps,
  });
  assert.equal(out, null);
});

test("validateWidget: rejects activity_stream in primary (context kind, wrong slot)", () => {
  // Activity feed belongs in secondary. Writing it to primary would
  // evict the real hero card every time the operator asked "show
  // activity" — exactly the dashboard-churn pattern the policy is
  // designed to prevent.
  const out = validateWidget({
    widgetKey: "k",
    kind: "activity_stream",
    slot: "primary",
    props: validActivityStreamProps,
  });
  assert.equal(out, null);
});

test("validateWidget: rejects workspace_rollup outside summary", () => {
  // The rollup has to stay in summary — moving it would break its
  // static widgetKey contract AND leave summary empty (no other
  // kind is allowed there per policy). Validator-level guard keeps
  // that invariant grep-auditable.
  const validRollupProps = {
    campaigns: { draft: 0, active: 0, closed: 0, archived: 0, total: 0 },
    invitees: { total: 0 },
    responses: { total: 0, attending: 0, declined: 0, recent_24h: 0 },
    invitations: { sent_24h: 0 },
    generated_at: "2026-04-19T10:00:00.000Z",
  };
  const out = validateWidget({
    widgetKey: "k",
    kind: "workspace_rollup",
    slot: "primary",
    props: validRollupProps,
  });
  assert.equal(out, null);
});
