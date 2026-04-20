// P8 — slot/kind policy tables.
//
// Two tables, both expressed as `... as const satisfies Record<...>`
// so a drift (new kind without a slot assignment, new slot without a
// composition mode) fails at the compiler instead of at the next
// widget write.
//
//   SLOT_POLICY      — maps each WidgetKind to the SINGLE WidgetSlot
//                      it's allowed to live in. The widget validator
//                      enforces this equality on every upsert so a
//                      tool that tries to emit `campaign_list` into
//                      the `action` slot (or any other mismatch)
//                      fails loudly at the validator boundary, not
//                      silently on the dashboard. This is also the
//                      source of truth that `upsertWidget`'s
//                      eviction logic uses when deciding "which
//                      widgets count as occupants of this slot?".
//
//   SLOT_COMPOSITION — how many widgets a slot can hold at once.
//                      `singleton-per-slot` means a new write evicts
//                      any OTHER widgetKey already in the slot;
//                      re-writing the SAME widgetKey updates in
//                      place (so the "same filter = same card" W4
//                      contract survives). `coexist-per-key` means
//                      the slot keeps every widgetKey alive as its
//                      own occupant — the action slot uses this so
//                      multiple concurrent confirm cards (send +
//                      import + draft) can sit side by side without
//                      evicting each other.
//
// Why both tables live in their own module rather than inside
// `widget-validate.ts`: the validator is a pure schema/shape gate
// (no DB, no policy context); the policy tables are consumed BOTH by
// the validator (for kind-slot matching) AND by `upsertWidget`'s
// eviction logic (for sibling lookup). Colocating them keeps the
// two consumers in lockstep without entangling the schema validator
// with the DB-side eviction helper.

import type { WidgetKind, WidgetSlot } from "./widget-validate";

// Kind -> slot. Every new widget kind added to WIDGET_KINDS must
// get a slot entry here OR the `satisfies` clause refuses to compile.
// If a future design wants to move a kind (e.g. a redesigned
// `contact_table` that lives in `secondary`), THIS is the one-line
// change that propagates through the validator, the eviction logic,
// and the composition tests below — no need to grep every tool
// handler for `slot:` literals.
export const SLOT_POLICY = {
  // summary — server-owned rollup. One and only one kind lives here.
  workspace_rollup: "summary",
  // primary — "hero" views. At most one of these shows at a time;
  // picking up a campaign card replaces the campaigns list, etc.
  campaign_list: "primary",
  campaign_card: "primary",
  contact_table: "primary",
  import_review: "primary",
  // secondary — "context" views that sit next to the hero card.
  // Also singleton-per-slot: re-summarising a different file replaces
  // the prior digest, re-asking for activity replaces the prior feed.
  activity_stream: "secondary",
  file_digest: "secondary",
  // action — operator confirm cards. coexist-per-key (see SLOT_COMPOSITION
  // below) so multiple concurrent confirms can stack without evicting
  // each other.
  confirm_draft: "action",
  confirm_send: "action",
  confirm_import: "action",
} as const satisfies Record<WidgetKind, WidgetSlot>;

export type SlotCompositionMode = "singleton-per-slot" | "coexist-per-key";

// Slot -> composition mode. The `action` slot is the ONLY
// coexist-per-key slot today; everything else is singleton-per-slot.
// Adding a new WidgetSlot to WIDGET_SLOTS requires a matching entry
// here — the `satisfies` clause enforces that.
//
// Why `summary` is singleton-per-slot when only one kind lives there:
// consistency. If a future design ever adds a second `summary` kind
// (say a "pinned tip" rollup alongside the workspace rollup), the
// policy stays honest — the new kind would evict the old, one at a
// time — without a special case in the eviction logic. Today the
// branch is unreachable at runtime (workspace_rollup is alone in
// summary) but pinning the policy here keeps the invariant visible.
export const SLOT_COMPOSITION = {
  summary: "singleton-per-slot",
  primary: "singleton-per-slot",
  secondary: "singleton-per-slot",
  action: "coexist-per-key",
} as const satisfies Record<WidgetSlot, SlotCompositionMode>;
