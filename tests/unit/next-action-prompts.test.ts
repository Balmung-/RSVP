import { test } from "node:test";
import assert from "node:assert/strict";

import { getNextAction } from "../../src/lib/ai/next-action-prompts";
import { WIDGET_KINDS, type WidgetKind } from "../../src/lib/ai/widget-validate";

// P8-B — unit tests for the per-kind next-action prompt resolver.
//
// These tests pin four invariants:
//   1. Exhaustive over `WIDGET_KINDS` — calling `getNextAction`
//      for every registered kind doesn't throw, and returns either
//      `null` or a `NextAction` with a non-empty label + prompt.
//   2. Specific kinds return specific prompts in EN and AR, so a
//      translation regression (wrong string, empty string) shows
//      up here.
//   3. `campaign_card` parameterizes on `props.name` when the name
//      is present, and falls back to a generic prompt when the
//      field is missing/empty/wrong-type.
//   4. Kinds that live in non-eligible slots (action/summary) or
//      are otherwise passive return null — no chip should render
//      for them.

const ELIGIBLE_KINDS: ReadonlyArray<WidgetKind> = [
  "campaign_list",
  "campaign_card",
  "contact_table",
  "import_review",
];

const NULL_KINDS: ReadonlyArray<WidgetKind> = [
  "activity_stream",
  "file_digest",
  "confirm_draft",
  "confirm_send",
  "confirm_import",
  "workspace_rollup",
];

// ---- 1. Exhaustive + shape ----

test("getNextAction: every widget kind returns null or a well-formed NextAction (en)", () => {
  // Iterating over `WIDGET_KINDS` (not ELIGIBLE_KINDS) catches
  // the case where a new kind is added to the registry without a
  // corresponding entry in next-action-prompts.ts. The TypeScript
  // exhaustiveness trap would already fail the build, but this
  // test catches a runtime regression too (e.g. a case that falls
  // through to `default`).
  for (const kind of WIDGET_KINDS) {
    const result = getNextAction({ kind, props: {} }, "en");
    if (result === null) continue;
    assert.equal(typeof result.label, "string");
    assert.equal(typeof result.prompt, "string");
    assert.ok(result.label.length > 0, `label empty for ${kind}`);
    assert.ok(result.prompt.length > 0, `prompt empty for ${kind}`);
  }
});

test("getNextAction: every widget kind returns null or a well-formed NextAction (ar)", () => {
  // Same shape check in Arabic — catches a missing AR branch in
  // any kind's switch arm that would silently fall through to the
  // EN strings or return null-by-accident.
  for (const kind of WIDGET_KINDS) {
    const result = getNextAction({ kind, props: {} }, "ar");
    if (result === null) continue;
    assert.equal(typeof result.label, "string");
    assert.equal(typeof result.prompt, "string");
    assert.ok(result.label.length > 0, `AR label empty for ${kind}`);
    assert.ok(result.prompt.length > 0, `AR prompt empty for ${kind}`);
  }
});

test("getNextAction: the eligible-kind set exactly matches what returns non-null", () => {
  // Guards against drift between the test's `ELIGIBLE_KINDS`
  // sentinel and the implementation's switch. If someone adds a
  // new `campaign_card_v2` and wires it into the resolver but
  // forgets to update the null-branches here, this test flags it.
  const actualEligible: WidgetKind[] = [];
  for (const kind of WIDGET_KINDS) {
    const r = getNextAction({ kind, props: {} }, "en");
    if (r !== null) actualEligible.push(kind);
  }
  assert.deepEqual(
    [...actualEligible].sort(),
    [...ELIGIBLE_KINDS].sort(),
    "eligible kinds must exactly match ELIGIBLE_KINDS sentinel",
  );
});

test("getNextAction: null-set kinds return null in both locales", () => {
  for (const kind of NULL_KINDS) {
    assert.equal(
      getNextAction({ kind, props: {} }, "en"),
      null,
      `${kind} must return null in en`,
    );
    assert.equal(
      getNextAction({ kind, props: {} }, "ar"),
      null,
      `${kind} must return null in ar`,
    );
  }
});

// ---- 2. Kind-specific prompts ----

test("getNextAction: campaign_list has a generic open-a-campaign prompt", () => {
  const en = getNextAction({ kind: "campaign_list", props: {} }, "en");
  assert.ok(en, "en campaign_list chip must exist");
  // We don't pin exact strings (a small copy edit shouldn't break
  // tests) but we DO pin the semantic shape — the chip nudges
  // toward picking ONE campaign from the list.
  assert.match(en.label.toLowerCase(), /campaign/);
  const ar = getNextAction({ kind: "campaign_list", props: {} }, "ar");
  assert.ok(ar, "ar campaign_list chip must exist");
  assert.ok(ar.label.length > 0);
  assert.ok(ar.prompt.length > 0);
});

test("getNextAction: contact_table nudges toward adding a contact (en + ar)", () => {
  const en = getNextAction({ kind: "contact_table", props: {} }, "en");
  assert.ok(en);
  assert.match(en.label.toLowerCase(), /contact/);
  const ar = getNextAction({ kind: "contact_table", props: {} }, "ar");
  assert.ok(ar);
  assert.ok(ar.label.length > 0);
});

test("getNextAction: import_review nudges toward commit", () => {
  const en = getNextAction({ kind: "import_review", props: {} }, "en");
  assert.ok(en);
  assert.match(en.prompt.toLowerCase(), /commit/);
  const ar = getNextAction({ kind: "import_review", props: {} }, "ar");
  assert.ok(ar);
  assert.ok(ar.prompt.length > 0);
});

// ---- 3. campaign_card parameterization on props.name ----

test("getNextAction: campaign_card interpolates props.name into the chip (en)", () => {
  // The specific repro: a named campaign should show the name in
  // both the chip label AND the seeded prompt. Without this, the
  // chip would read "Send invites" for every campaign card — a
  // worse UX than the pre-P8-B state (no chip at all).
  const result = getNextAction(
    {
      kind: "campaign_card",
      props: { name: "Summer Gala 2026" },
    },
    "en",
  );
  assert.ok(result, "campaign_card with name must return a chip");
  assert.match(result.label, /Summer Gala 2026/);
  assert.match(result.prompt, /Summer Gala 2026/);
});

test("getNextAction: campaign_card interpolates props.name into the chip (ar)", () => {
  const result = getNextAction(
    {
      kind: "campaign_card",
      props: { name: "حفل الصيف 2026" },
    },
    "ar",
  );
  assert.ok(result);
  assert.match(result.label, /حفل الصيف 2026/);
  assert.match(result.prompt, /حفل الصيف 2026/);
});

test("getNextAction: campaign_card falls back to generic prompt when name is empty", () => {
  // Pathological-but-possible: a widget writer that passes
  // `name: ""`. The validator should have rejected it, but the
  // resolver must still produce a useful chip rather than
  // `"Send invites for "` (with a trailing space).
  const result = getNextAction(
    { kind: "campaign_card", props: { name: "" } },
    "en",
  );
  assert.ok(result);
  // No trailing "for " artifact.
  assert.doesNotMatch(result.label, /for $/);
  assert.doesNotMatch(result.prompt, /for $/);
});

test("getNextAction: campaign_card falls back to generic prompt when name is missing", () => {
  const result = getNextAction(
    { kind: "campaign_card", props: {} },
    "en",
  );
  assert.ok(result);
  assert.ok(result.label.length > 0);
  // Should not contain "undefined" as a literal substring from a
  // template-string slip-up (e.g. `${undefined}`).
  assert.doesNotMatch(result.label, /undefined/);
  assert.doesNotMatch(result.prompt, /undefined/);
});

test("getNextAction: campaign_card falls back to generic prompt when name is wrong type", () => {
  // Defence against a producer that stores `name: 42` or
  // `name: null`. readString returns null for non-string values;
  // the fallback branch produces a generic chip.
  for (const badName of [42, null, {}, ["nope"], true]) {
    const result = getNextAction(
      { kind: "campaign_card", props: { name: badName as unknown } },
      "en",
    );
    assert.ok(result, `result must be non-null for bad name ${String(badName)}`);
    assert.ok(result.label.length > 0);
    assert.doesNotMatch(result.label, /\d+/); // no raw number leaked
    assert.doesNotMatch(result.label, /\[object Object\]/);
  }
});
