import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveSendCampaignSummary,
  type SendCampaignChannelInput,
  type SendCampaignDispatchResult,
} from "../../src/lib/ai/tools/send-campaign-summary";

// P14-D' — pins the post-dispatch summary derivation extracted from
// `send_campaign.ts`'s handler. Before the extraction, the total
// sum, per-channel breakdown filter, and summary-line composition
// all lived inline in a handler that pulls in prisma + the campaigns
// orchestrator + the provider dispatcher — no unit-level test could
// exercise the three transformations in isolation.
//
// Regression surface protected here:
//
//   - `total = email + sms + whatsapp` sum — dropping `whatsapp` silently
//     under-counts the operator-facing total on a "whatsapp" or "all"
//     send. Visible in the transcript and on the widget's outcome blob.
//   - Per-channel breakdown filter — the channel→included matrix:
//       email:    "email" | "both" | "all"
//       sms:      "sms" | "both" | "all"
//       whatsapp: "whatsapp" | "all"
//     `"both"` is the pre-P13 two-channel vocabulary and MUST NOT
//     silently widen to include whatsapp (legacy callers would drift).
//   - Pluralization branch — `total === 1` is the only singular case.
//   - Skipped/failed line conditionals — emit only when > 0. A
//     regression that always emits would paint "Skipped 0. Failed 0."
//     on every success, adding noise to the audit stream.
//   - Summary join — single space. The confirm-flow's outcome writer
//     persists this string on the widget and the validator requires
//     non-empty; an empty join would crash the write.

// ---- helpers ----

// Build a dispatch-result tally with sensible defaults. Every field
// overrideable so each test isolates one transformation.
function makeResult(
  overrides: Partial<SendCampaignDispatchResult> = {},
): SendCampaignDispatchResult {
  return {
    email: 0,
    sms: 0,
    whatsapp: 0,
    skipped: 0,
    failed: 0,
    ...overrides,
  };
}

// Run the helper against a minimal fixture — most tests only care
// about one or two of the three transformations.
function run(
  channel: SendCampaignChannelInput,
  result: Partial<SendCampaignDispatchResult> = {},
  campaignName = "Test Campaign",
) {
  return deriveSendCampaignSummary({
    campaignName,
    channel,
    result: makeResult(result),
  });
}

// ---- (1) total ----

test("deriveSendCampaignSummary: total = email + sms + whatsapp", () => {
  // The three-way sum is THE regression vector. A refactor that drops
  // whatsapp (pre-P13-C call site that predates the additive counter)
  // would under-count the operator-visible tally.
  const out = run("all", { email: 3, sms: 5, whatsapp: 7 });
  assert.equal(out.total, 15);
});

test("deriveSendCampaignSummary: total is 0 when every counter is 0", () => {
  // Pathological but valid case — a "nothing to send" that somehow
  // landed past the blockers. The summary must still compose cleanly.
  const out = run("all", { email: 0, sms: 0, whatsapp: 0 });
  assert.equal(out.total, 0);
});

test("deriveSendCampaignSummary: total excludes skipped and failed (only successful deliveries count)", () => {
  // The "Sent N messages" line is about successful deliveries, not
  // attempts. A regression folding skipped/failed into total would
  // inflate the operator-facing count against the actual delivered
  // count.
  const out = run("email", { email: 3, skipped: 5, failed: 2 });
  assert.equal(out.total, 3);
});

// ---- (2) breakdown filter ----

test("deriveSendCampaignSummary: channel='email' → breakdown has ONLY email", () => {
  // Scalar email send. sms / whatsapp MUST NOT appear even with 0 counts.
  const out = run("email", { email: 3, sms: 1, whatsapp: 2 });
  assert.deepEqual(out.breakdown, ["3 email"]);
});

test("deriveSendCampaignSummary: channel='sms' → breakdown has ONLY sms", () => {
  const out = run("sms", { email: 3, sms: 1, whatsapp: 2 });
  assert.deepEqual(out.breakdown, ["1 sms"]);
});

test("deriveSendCampaignSummary: channel='whatsapp' → breakdown has ONLY whatsapp", () => {
  // Most important scalar case — operator asked for whatsapp, must NOT
  // see "0 email, 0 sms" padding the breakdown.
  const out = run("whatsapp", { email: 3, sms: 1, whatsapp: 2 });
  assert.deepEqual(out.breakdown, ["2 whatsapp"]);
});

test("deriveSendCampaignSummary: channel='both' → breakdown has email + sms, NO whatsapp", () => {
  // Pre-P13 legacy vocabulary — "both" = email + SMS. Silently
  // widening to include whatsapp would drift legacy callers that
  // expect the two-channel semantics.
  const out = run("both", { email: 3, sms: 1, whatsapp: 2 });
  assert.deepEqual(out.breakdown, ["3 email", "1 sms"]);
});

test("deriveSendCampaignSummary: channel='all' → breakdown has all three channels", () => {
  // The umbrella channel — P13-C widening. Order is email → sms →
  // whatsapp, matching the insertion order in the helper.
  const out = run("all", { email: 3, sms: 1, whatsapp: 2 });
  assert.deepEqual(out.breakdown, ["3 email", "1 sms", "2 whatsapp"]);
});

test("deriveSendCampaignSummary: breakdown keeps zero counters for included channels", () => {
  // A "both" send that delivered zero email and one sms should show
  // "0 email, 1 sms" so the operator sees the email attempt (e.g. all
  // invitees had sms-only preferences). The filter is about channel
  // INCLUSION, not counter non-zero.
  const out = run("both", { email: 0, sms: 1 });
  assert.deepEqual(out.breakdown, ["0 email", "1 sms"]);
});

// ---- (3) pluralization branch ----

test("deriveSendCampaignSummary: total === 1 → 'message' (singular)", () => {
  const out = run("email", { email: 1 });
  assert.ok(
    out.summaryLines[0].includes("Sent 1 message "),
    `expected singular 'message', got: ${out.summaryLines[0]}`,
  );
  assert.ok(
    !out.summaryLines[0].includes("messages"),
    "should not include 'messages' when total === 1",
  );
});

test("deriveSendCampaignSummary: total === 0 → 'messages' (plural)", () => {
  // English: "0 messages" is plural. A bug treating 0 as singular
  // would paint "Sent 0 message" on a nothing-delivered success.
  const out = run("email", {});
  assert.ok(
    out.summaryLines[0].includes("Sent 0 messages "),
    `expected plural 'messages' for zero, got: ${out.summaryLines[0]}`,
  );
});

test("deriveSendCampaignSummary: total === 2 → 'messages' (plural)", () => {
  const out = run("email", { email: 2 });
  assert.ok(
    out.summaryLines[0].includes("Sent 2 messages "),
    `expected plural 'messages', got: ${out.summaryLines[0]}`,
  );
});

// ---- (4) skipped line conditional ----

test("deriveSendCampaignSummary: skipped === 0 → no 'Skipped' line", () => {
  const out = run("email", { email: 3, skipped: 0 });
  const skippedLines = out.summaryLines.filter((l) => l.startsWith("Skipped"));
  assert.equal(skippedLines.length, 0);
});

test("deriveSendCampaignSummary: skipped > 0 → one 'Skipped N.' line", () => {
  const out = run("email", { email: 3, skipped: 5 });
  const skippedLines = out.summaryLines.filter((l) => l.startsWith("Skipped"));
  assert.deepEqual(skippedLines, ["Skipped 5."]);
});

// ---- (5) failed line conditional ----

test("deriveSendCampaignSummary: failed === 0 → no 'Failed' line", () => {
  const out = run("email", { email: 3, failed: 0 });
  const failedLines = out.summaryLines.filter((l) => l.startsWith("Failed"));
  assert.equal(failedLines.length, 0);
});

test("deriveSendCampaignSummary: failed > 0 → one 'Failed N — …' line with pointer to activity page", () => {
  // The "see activity page" pointer is operator-actionable: they
  // click through to inspect per-invitee errors. If the pointer
  // drifts, the audit stream gets harder to navigate.
  const out = run("email", { email: 3, failed: 2 });
  const failedLines = out.summaryLines.filter((l) => l.startsWith("Failed"));
  assert.equal(failedLines.length, 1);
  assert.match(
    failedLines[0]!,
    /^Failed 2 — see the campaign's activity page for per-invitee errors\.$/,
  );
});

test("deriveSendCampaignSummary: both skipped AND failed > 0 emit both lines in order", () => {
  // Both conditions true — skipped line comes first, failed after.
  // Pinning the order so a future refactor can't reorder them and
  // silently drift the audit-stream prefix grep.
  const out = run("email", { email: 3, skipped: 5, failed: 2 });
  assert.equal(out.summaryLines.length, 3);
  assert.match(out.summaryLines[0]!, /^Sent 3 messages /);
  assert.match(out.summaryLines[1]!, /^Skipped 5\.$/);
  assert.match(out.summaryLines[2]!, /^Failed 2 /);
});

// ---- (6) summary string composition ----

test("deriveSendCampaignSummary: summary joins summaryLines with single space", () => {
  // The persisted outcome `summary` field on the widget is
  // `summaryLines.join(" ")`. Pinning the separator so a switch to
  // "\n" or "; " doesn't silently drift the widget-persisted copy.
  const out = run("email", { email: 3, skipped: 1 });
  assert.equal(
    out.summary,
    `${out.summaryLines[0]} ${out.summaryLines[1]}`,
  );
});

test("deriveSendCampaignSummary: summary is always non-empty even on a zero-total send", () => {
  // The widget validator's `outcome.summary` is a required non-empty
  // string. A zero-total success must still produce a valid summary —
  // the "Sent 0 messages" line is always emitted first.
  const out = run("email", {});
  assert.ok(out.summary.length > 0);
  assert.ok(out.summary.includes("Sent 0 messages"));
});

// ---- (7) campaign-name passthrough ----

test("deriveSendCampaignSummary: campaignName is quoted verbatim in the first line", () => {
  // The campaign name is operator-provided and can contain quotes,
  // punctuation, etc. The helper does NOT escape or truncate — it's
  // the confirm-flow's widget writer that runs validator-level checks
  // before persisting. Pinning the passthrough here so a future
  // refactor that adds "sanitization" still has to justify changing
  // this shape.
  const out = run("email", { email: 1 }, "Alice & Bob's Wedding");
  assert.ok(
    out.summaryLines[0]!.includes(`"Alice & Bob's Wedding"`),
    `expected verbatim campaign name in quotes, got: ${out.summaryLines[0]}`,
  );
});

// ---- (8) output shape drift guard ----

test("deriveSendCampaignSummary: returns EXACTLY total, breakdown, summaryLines, summary", () => {
  // Pinning the return shape so a future field addition forces a
  // test update. Matches what the handler reads off the helper.
  const out = run("email", { email: 1 });
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, ["breakdown", "summary", "summaryLines", "total"]);
});
