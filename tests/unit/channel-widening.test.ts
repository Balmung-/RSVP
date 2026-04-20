import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeChannels, CHANNELS } from "../../src/lib/stages";
import { channelSetFor } from "../../src/lib/campaigns";

// P13-C — channel widening (email / sms / whatsapp) across the
// runtime send path.
//
// These tests pin the two pure helpers that fan out the new channel
// vocabulary:
//
//   1. `normalizeChannels` in stages.ts — parses a stored CSV
//      string (`CampaignStage.channels`) into a validated array
//      of `Channel` values. Unknown tokens are filtered out; the
//      output order is always CHANNELS-declaration order, not
//      input order.
//
//   2. `channelSetFor` in campaigns.ts — resolves a
//      `SendCampaignChannel` selector ("email" | "sms" |
//      "whatsapp" | "both" | "all") into the concrete Set of
//      scalar channels the dispatcher iterates. "both" preserves
//      the pre-P13 semantics (email + sms, NOT whatsapp); "all"
//      is the post-P13 umbrella that includes WhatsApp.
//
// Anything that sends via sendCampaign / resendSelection / runStage
// depends on these two pure functions producing the right set.
// Pinning them here means a regression (e.g. "both" silently
// starts including WhatsApp) lands with a loud unit-test failure
// before it lands in production as an unwanted send.

// ---- normalizeChannels ------------------------------------------

test("normalizeChannels: null / undefined / empty fall back to email,sms (pre-P13 default)", () => {
  // Existing CampaignStage rows were saved before WhatsApp existed;
  // their `channels` column is either "email,sms" or null. If we
  // silently flipped the default to include WhatsApp, every
  // legacy stage would start sending WhatsApp on the next fire —
  // a correctness bug operators couldn't see until their audience
  // got an unexpected Meta notification. Operators opt IN.
  assert.deepEqual(normalizeChannels(null), ["email", "sms"]);
  assert.deepEqual(normalizeChannels(undefined), ["email", "sms"]);
  // Empty string is different from null: the split produces [""],
  // which matches no CHANNELS entry, so the filter yields [].
  // Not the null fallback — a caller that stored "" deliberately
  // disabled all channels.
  assert.deepEqual(normalizeChannels(""), []);
});

test("normalizeChannels: 'whatsapp' alone is accepted", () => {
  // WhatsApp-only stage — a plausible operator configuration for a
  // team that primarily reaches invitees over WhatsApp and uses
  // email as a follow-up only.
  assert.deepEqual(normalizeChannels("whatsapp"), ["whatsapp"]);
});

test("normalizeChannels: 'email,sms,whatsapp' accepts all three", () => {
  assert.deepEqual(normalizeChannels("email,sms,whatsapp"), [
    "email",
    "sms",
    "whatsapp",
  ]);
});

test("normalizeChannels: output order is CHANNELS declaration order, not input order", () => {
  // Input reversed; output still canonical. Matters because a
  // downstream reader comparing arrays (e.g. audit tooling that
  // checks stage.channels vs a known-good set) shouldn't care
  // how the operator ordered their selections in the editor.
  assert.deepEqual(normalizeChannels("whatsapp,sms,email"), [
    "email",
    "sms",
    "whatsapp",
  ]);
});

test("normalizeChannels: whitespace around tokens tolerated", () => {
  // A hand-edited DB row or a form field with stray spaces shouldn't
  // silently drop channels.
  assert.deepEqual(normalizeChannels(" email , whatsapp "), [
    "email",
    "whatsapp",
  ]);
});

test("normalizeChannels: unknown tokens filtered without poisoning the result", () => {
  // "mms" was a proposed channel name that never shipped; "push"
  // is a plausible future addition. Either way, an unknown token
  // in the stored column must not corrupt the parse — the stage
  // keeps firing on its valid channels and the unknown is dropped.
  assert.deepEqual(normalizeChannels("email,mms,whatsapp,push"), [
    "email",
    "whatsapp",
  ]);
});

test("normalizeChannels: case-insensitive on input", () => {
  // The DB column is stored lowercase, but a hand-imported row or
  // a future admin migration could land mixed case.
  assert.deepEqual(normalizeChannels("EMAIL,WhatsApp"), [
    "email",
    "whatsapp",
  ]);
});

test("CHANNELS constant exposes all three scalar channels", () => {
  // Mirror the runtime expectation — if the constant gets trimmed
  // back to ["email", "sms"] by accident, the planner + dispatcher
  // would silently stop accepting WhatsApp in stored channels.
  assert.deepEqual([...CHANNELS], ["email", "sms", "whatsapp"]);
});

// ---- channelSetFor ----------------------------------------------

test("channelSetFor: 'email' scalar → {email}", () => {
  assert.deepEqual([...channelSetFor("email")].sort(), ["email"]);
});

test("channelSetFor: 'sms' scalar → {sms}", () => {
  assert.deepEqual([...channelSetFor("sms")].sort(), ["sms"]);
});

test("channelSetFor: 'whatsapp' scalar → {whatsapp}", () => {
  assert.deepEqual([...channelSetFor("whatsapp")].sort(), ["whatsapp"]);
});

test("channelSetFor: 'both' stays email + sms (NOT whatsapp)", () => {
  // This is the load-bearing invariant of the whole P13-C
  // widening. Every pre-P13 caller (admin UI bulk send, approvals
  // re-fire, the AI send_campaign tool) passes "both", and they
  // were written against the email+sms semantics. Flipping "both"
  // to include WhatsApp would be a silent behavior change that
  // sends WhatsApp messages for every unaudited caller.
  assert.deepEqual([...channelSetFor("both")].sort(), ["email", "sms"]);
});

test("channelSetFor: 'all' is the post-P13 umbrella (all three)", () => {
  // Callers that have been audited for WhatsApp readiness opt in
  // via "all". This will be the destination value P13-D's UI
  // selector uses when the operator explicitly picks "every
  // channel".
  assert.deepEqual([...channelSetFor("all")].sort(), [
    "email",
    "sms",
    "whatsapp",
  ]);
});

test("channelSetFor: returned Set is a fresh instance per call", () => {
  // The dispatcher uses `.has(...)` lookups — we rely on the Set
  // being owned by the current send. If two concurrent sends
  // shared a Set (e.g. from a module-level cache) one could mutate
  // it and corrupt the other. Keep each call's Set isolated.
  const a = channelSetFor("all");
  const b = channelSetFor("all");
  assert.notEqual(a, b);
  a.delete("whatsapp");
  assert.equal(b.has("whatsapp"), true);
});
