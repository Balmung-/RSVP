import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANCHOR_MAP,
  classifyPreClaim,
  type PreClaimRow,
} from "../../src/lib/ai/confirm-preclaim";

// P14-B' — pre-claim classifier pins for /api/chat/confirm/[messageId].
//
// Pre-P14-B', four denial branches in the confirm route had ZERO test
// coverage: `wrong_tool`, `anchor_was_error`, `already_confirmed`
// (fast-path), and `corrupt_input`. Each of those branches fires a
// `logAction` event with a specific kind / reason / payload shape, and
// returns a specific HTTP status code + error body. The wiring lived
// inline in route.ts — which pulls in the Next runtime (NextResponse,
// cookies, prisma) and can't be loaded from a plain node test.
//
// The classifier is now a pure function: (row, messageId) → outcome.
// Every field on the `denied` variant corresponds DIRECTLY to a
// side-effect the route fires (audit kind, audit data, HTTP status,
// error code). A regression that drops an audit event, flips a status
// code, or mis-labels a denial reason will FAIL here — no Next runtime
// required.
//
// Regression surface this exposes:
//   - Audit stream drift: `reason` is the operator-visible denial code
//     in the audit log. Silent rename would break every grep /
//     filter-by-reason the ops team has built.
//   - Per-tool vs generic audit kind: `wrong_tool` MUST use
//     `ai.denied.confirm` (the generic fallback — we can't resolve a
//     per-tool denied kind when the tool isn't in ANCHOR_MAP); every
//     other denial MUST use `anchorConfig.deniedAuditKind`. A regression
//     swapping these would contaminate the per-tool audit streams
//     with generic events OR vice versa.
//   - Status-code contract: `already_confirmed` is 409, all others are
//     400. The client distinguishes these — 409 triggers a "this was
//     already confirmed" toast, 400 triggers the generic denial UI.
//   - Fast-path ordering: the order of checks (wrong_tool →
//     anchor_was_error → already_confirmed → corrupt_input) matters for
//     audit correctness. If anchor_was_error were checked first, a
//     row with toolName=null + isError=true would audit under
//     anchor_was_error with a MISSING anchor_config. The current
//     ordering guarantees we have a resolved anchor before any
//     per-tool-keyed audit fires.

// ---- helpers ----

// Build a minimal row with the fields the classifier reads. Everything
// overrideable so each test can isolate the branch it's exercising.
function makeRow(overrides: Partial<PreClaimRow> = {}): PreClaimRow {
  return {
    toolName: "propose_send",
    toolInput: null,
    isError: false,
    confirmedAt: null,
    sessionId: "s-1",
    ...overrides,
  };
}

// ---- (1) wrong_tool ----

test("classifyPreClaim: unknown toolName → wrong_tool denial under generic audit kind", () => {
  const out = classifyPreClaim({
    row: makeRow({ toolName: "propose_something_else" }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.error, "wrong_tool");
  assert.equal(out.status, 400);
  // Generic audit kind — not a per-tool kind, because we don't know
  // which destructive tool the attempt targeted. Pinning this explicitly
  // catches the regression where a future refactor picks a per-tool
  // kind here (wrong — we'd have to make one up).
  assert.equal(out.auditKind, "ai.denied.confirm");
  assert.deepEqual(out.auditData, {
    via: "confirm",
    reason: "wrong_tool",
    messageId: "m-1",
    toolName: "propose_something_else",
  });
});

test("classifyPreClaim: null toolName → wrong_tool denial (toolName appears as null in audit data)", () => {
  // Rows with a null `toolName` column hit the same branch as an
  // unknown toolName — both yield undefined on the ANCHOR_MAP lookup.
  // The audit data preserves the actual null so an ops filter on
  // `toolName IS NULL` still matches.
  const out = classifyPreClaim({
    row: makeRow({ toolName: null }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.error, "wrong_tool");
  assert.equal(out.auditKind, "ai.denied.confirm");
  assert.equal(out.auditData.toolName, null);
});

test("classifyPreClaim: empty-string toolName → wrong_tool denial", () => {
  // The route's inline code used `row.toolName ? ANCHOR_MAP[row.toolName] : undefined`
  // — empty string is falsy, so it hit the wrong_tool branch via the
  // truthiness check rather than via a missing key. Behaviour preserved.
  const out = classifyPreClaim({
    row: makeRow({ toolName: "" }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.error, "wrong_tool");
});

// ---- (2) anchor_was_error ----

test("classifyPreClaim: propose_send with isError=true → anchor_was_error under send_campaign denied kind", () => {
  const out = classifyPreClaim({
    row: makeRow({ toolName: "propose_send", isError: true }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.error, "anchor_was_error");
  assert.equal(out.status, 400);
  // Per-tool kind because we DO know the targeted tool — the anchor
  // is in ANCHOR_MAP, we just won't dispatch because its propose
  // failed.
  assert.equal(out.auditKind, "ai.denied.send_campaign");
  assert.deepEqual(out.auditData, {
    via: "confirm",
    reason: "anchor_was_error",
    messageId: "m-1",
  });
});

test("classifyPreClaim: propose_import with isError=true → anchor_was_error under commit_import denied kind", () => {
  // Symmetry pin for the import flow. A regression swapping the per-tool
  // kinds (send ↔ import) would show up here.
  const out = classifyPreClaim({
    row: makeRow({ toolName: "propose_import", isError: true }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.auditKind, "ai.denied.commit_import");
});

// ---- (3) already_confirmed ----

test("classifyPreClaim: confirmedAt set on propose_send → already_confirmed 409 with isoString in data", () => {
  const confirmedAt = new Date("2026-04-20T10:00:00.000Z");
  const out = classifyPreClaim({
    row: makeRow({ toolName: "propose_send", confirmedAt }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.error, "already_confirmed");
  // 409 specifically — distinct from the other three 400s. The client
  // branches on this to show "already confirmed" rather than the
  // generic denial UI.
  assert.equal(out.status, 409);
  assert.equal(out.auditKind, "ai.denied.send_campaign");
  assert.deepEqual(out.auditData, {
    via: "confirm",
    reason: "already_confirmed",
    messageId: "m-1",
    // ISO string (not Date, not epoch ms). logAction writes JSON into
    // the audit row, and Date objects don't JSON.stringify to a useful
    // shape — explicit toISOString() here is load-bearing.
    confirmedAt: confirmedAt.toISOString(),
  });
});

test("classifyPreClaim: confirmedAt set on propose_import → already_confirmed under commit_import denied kind", () => {
  const confirmedAt = new Date("2026-04-20T10:00:00.000Z");
  const out = classifyPreClaim({
    row: makeRow({ toolName: "propose_import", confirmedAt }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.auditKind, "ai.denied.commit_import");
  assert.equal(out.auditData.confirmedAt, confirmedAt.toISOString());
});

// ---- (4) corrupt_input ----

test("classifyPreClaim: non-JSON toolInput → corrupt_input under per-tool denied kind", () => {
  // Intentionally unparseable — a simple garbage string the route used
  // to try to JSON.parse inline.
  const out = classifyPreClaim({
    row: makeRow({
      toolName: "propose_send",
      toolInput: "this is not json",
    }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.error, "corrupt_input");
  assert.equal(out.status, 400);
  assert.equal(out.auditKind, "ai.denied.send_campaign");
  assert.deepEqual(out.auditData, {
    via: "confirm",
    reason: "corrupt_input",
    messageId: "m-1",
  });
});

test("classifyPreClaim: truncated JSON toolInput → corrupt_input", () => {
  // A more realistic failure mode — a write that was cut short mid-
  // serialize. Same branch, same audit.
  const out = classifyPreClaim({
    row: makeRow({
      toolName: "propose_import",
      toolInput: '{"ingestId": "ing-1", "targ',
    }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.error, "corrupt_input");
  assert.equal(out.auditKind, "ai.denied.commit_import");
});

// ---- (5) ok ----

test("classifyPreClaim: valid propose_send with no toolInput → ok, parsedInput defaults to {}", () => {
  // A row whose toolInput column is null (valid — the destructive tool
  // accepts degenerate empty input and fails with its own validator).
  const out = classifyPreClaim({
    row: makeRow({ toolName: "propose_send", toolInput: null }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(out.anchorConfig.destructiveTool, "send_campaign");
  assert.equal(out.anchorConfig.confirmAuditKind, "ai.confirm.send_campaign");
  assert.equal(out.anchorConfig.deniedAuditKind, "ai.denied.send_campaign");
  // `{}` is the degenerate empty input — matches the pre-P14-B' inline
  // `let parsedInput: unknown = {}` default.
  assert.deepEqual(out.parsedInput, {});
});

test("classifyPreClaim: valid propose_send with well-formed JSON toolInput → ok, parsedInput carries the parsed object", () => {
  const out = classifyPreClaim({
    row: makeRow({
      toolName: "propose_send",
      toolInput: JSON.stringify({
        campaign_id: "c-1",
        channel: "email",
        only_unsent: true,
      }),
    }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.deepEqual(out.parsedInput, {
    campaign_id: "c-1",
    channel: "email",
    only_unsent: true,
  });
});

test("classifyPreClaim: valid propose_import → ok with commit_import anchor", () => {
  // Symmetry pin — the classifier MUST resolve the import anchor
  // when toolName === "propose_import".
  const out = classifyPreClaim({
    row: makeRow({
      toolName: "propose_import",
      toolInput: JSON.stringify({
        ingestId: "ing-1",
        target: "contacts",
      }),
    }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(out.anchorConfig.destructiveTool, "commit_import");
  assert.equal(
    out.anchorConfig.confirmAuditKind,
    "ai.confirm.commit_import",
  );
  assert.equal(
    out.anchorConfig.deniedAuditKind,
    "ai.denied.commit_import",
  );
  assert.deepEqual(out.parsedInput, {
    ingestId: "ing-1",
    target: "contacts",
  });
});

// ---- (6) branch-ordering invariants ----

test("classifyPreClaim: wrong_tool takes precedence over isError", () => {
  // A row with an unknown toolName AND isError=true must surface as
  // `wrong_tool` (not `anchor_was_error`). Reason: without a resolved
  // anchor, we can't pick a per-tool denied kind for anchor_was_error,
  // so the classifier has to fail at the wrong_tool gate first.
  const out = classifyPreClaim({
    row: makeRow({ toolName: "unknown", isError: true }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.error, "wrong_tool");
});

test("classifyPreClaim: isError takes precedence over confirmedAt", () => {
  // A row that both (a) had a failed propose AND (b) was subsequently
  // claimed must surface as `anchor_was_error` (not `already_confirmed`).
  // An isError anchor shouldn't have been claimable at all; surfacing
  // anchor_was_error preserves the "this propose failed" signal over
  // the "this was already confirmed" signal, which is strictly more
  // diagnostic for ops investigation.
  const confirmedAt = new Date();
  const out = classifyPreClaim({
    row: makeRow({
      toolName: "propose_send",
      isError: true,
      confirmedAt,
    }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.error, "anchor_was_error");
});

test("classifyPreClaim: already_confirmed takes precedence over corrupt_input", () => {
  // A row that was confirmed AND has corrupt toolInput surfaces as
  // `already_confirmed`. Reason: if the anchor is already claimed, we
  // shouldn't pay for the JSON.parse at all — the whole fast-path
  // exists to short-circuit BEFORE the parse + ctx build.
  const out = classifyPreClaim({
    row: makeRow({
      toolName: "propose_send",
      toolInput: "not json",
      confirmedAt: new Date(),
    }),
    messageId: "m-1",
  });
  assert.equal(out.kind, "denied");
  if (out.kind !== "denied") return;
  assert.equal(out.error, "already_confirmed");
  // The 409 status is preserved — if corrupt_input leaked through,
  // we'd see a 400 here instead.
  assert.equal(out.status, 409);
});

// ---- (7) ANCHOR_MAP drift guard ----

test("ANCHOR_MAP: exactly two entries — propose_send + propose_import", () => {
  // Meta-pin on the anchor registry. Adding a new destructive tool
  // requires extending THREE things in lockstep (see module doc):
  //   1. ANCHOR_MAP (this file)
  //   2. A new runConfirm* flow + its ConfirmPort bindings
  //   3. The matching widget kind in widget-validate.ts::WIDGET_KINDS
  // If someone adds to ANCHOR_MAP without doing (2) and (3), the
  // route's `if (row.toolName === "propose_send") ... else ...` branch
  // will fall into the import path by default — a real
  // misclassification bug. This test forces a cross-file update in
  // the same commit as any ANCHOR_MAP extension.
  const keys = Object.keys(ANCHOR_MAP).sort();
  assert.deepEqual(keys, ["propose_import", "propose_send"]);
});

test("ANCHOR_MAP: every entry's confirmAuditKind / deniedAuditKind pair stays paired to the same destructiveTool", () => {
  // Drift guard: a typo in ANCHOR_MAP could cross-wire
  // `propose_send → ai.confirm.commit_import` or similar, which would
  // pollute the import audit stream with send events. Walk the map
  // and assert each entry's three strings agree on the tool name.
  for (const [key, cfg] of Object.entries(ANCHOR_MAP)) {
    const suffix = cfg.destructiveTool;
    assert.equal(
      cfg.confirmAuditKind,
      `ai.confirm.${suffix}`,
      `ANCHOR_MAP[${key}].confirmAuditKind mismatch`,
    );
    assert.equal(
      cfg.deniedAuditKind,
      `ai.denied.${suffix}`,
      `ANCHOR_MAP[${key}].deniedAuditKind mismatch`,
    );
  }
});
