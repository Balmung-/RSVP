import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSystemPrompt,
  renderSystemPrompt,
  type SystemPromptInput,
} from "../../src/lib/ai/system-prompt";

// P16-D — pins for the system-prompt injection seam.
//
// The chat route assembles the two system blocks (static + dynamic)
// via `buildSystemPrompt`. P16-D adds an optional `memoryContext`
// string that the builder splices into the DYNAMIC block between
// the grounding line and the tenant context. These pins cover the
// contract GPT's acceptance criteria rests on:
//
//   - "Recalled memory appears in the model input" — the memory
//     string MUST show up in the rendered prompt (both in
//     `buildSystemPrompt(...)`'s dynamic block and in the joined
//     `renderSystemPrompt(...)` convenience form).
//   - "No dangling heading on zero-memory turns" — empty/undefined
//     `memoryContext` MUST NOT add extra whitespace or a heading
//     the caller didn't ask for.
//   - Placement stability — memory lives ABOVE tenant context and
//     BELOW the grounding line, so the model reads durable context
//     before point-in-time state.
//
// This layer doesn't know about the RENDERER (that's
// memory-context-render.test.ts) or the GATHER (memory-recall-gather
// .test.ts); it only tests that whatever string gets handed in
// lands at the right spot in the system-prompt output.

// Reusable baseline input. Most tests override only `memoryContext`.
const baseInput: SystemPromptInput = {
  locale: "en",
  tenantContext: "## Tenant context (snapshot)\nsome tenant markdown",
  nowLocal: "Tuesday, October 21, 2025 at 09:00 AM",
  tz: "Asia/Riyadh",
  todayKey: "2025-10-21",
};

// ---- injection present -----------------------------------------

test("system-prompt: memoryContext is injected into the dynamic block", () => {
  // GPT acceptance: recalled memory appears in the model input.
  // We hand a literal memory string in; it MUST appear in the
  // rendered dynamic block.
  const memoryContext = [
    "### Durable memories (team-scoped, operator-authored)",
    "safety posture line",
    "",
    "#### Team: Ministry Events",
    "- [fact, 2025-10-15] operator prefers morning sends",
  ].join("\n");
  const parts = buildSystemPrompt({ ...baseInput, memoryContext });
  assert.ok(
    parts.dynamic.includes("### Durable memories"),
    "memory heading must appear in dynamic block",
  );
  assert.ok(
    parts.dynamic.includes("operator prefers morning sends"),
    "memory body must appear in dynamic block",
  );
});

test("system-prompt: renderSystemPrompt (joined) also contains the memory block", () => {
  // The convenience form is what some tests / simple invocations
  // use. Pin that it carries the same memory injection.
  const memoryContext = "### Durable memories\n- [fact, 2025-10-15] pinned bullet";
  const joined = renderSystemPrompt({ ...baseInput, memoryContext });
  assert.ok(joined.includes("### Durable memories"));
  assert.ok(joined.includes("pinned bullet"));
});

// ---- placement pins --------------------------------------------

test("system-prompt: memory sits BETWEEN grounding line and tenant context", () => {
  // Placement: grounding (locale + now) first, memory second,
  // tenant context last. A regression that swaps memory and
  // tenant-context (making the model read point-in-time state
  // before durable rules) would trip this.
  const memoryContext = "### Durable memories\n- memory bullet";
  const parts = buildSystemPrompt({
    ...baseInput,
    tenantContext: "## Tenant context (snapshot)\ntenant body",
    memoryContext,
  });
  const idxNow = parts.dynamic.indexOf("Now (local");
  const idxMem = parts.dynamic.indexOf("### Durable memories");
  const idxTen = parts.dynamic.indexOf("## Tenant context");
  assert.ok(idxNow >= 0 && idxMem >= 0 && idxTen >= 0, "all three sections present");
  assert.ok(idxNow < idxMem, "grounding comes before memory");
  assert.ok(idxMem < idxTen, "memory comes before tenant context");
});

test("system-prompt: memory does NOT leak into the static block", () => {
  // The static block is the cache prefix — it must stay IDENTICAL
  // across turns (different memories per turn). If a regression
  // puts memory into static, the prompt cache would invalidate on
  // every turn. This pin is load-bearing for caching economics.
  const memoryContext = "### Durable memories\n- some memory";
  const parts = buildSystemPrompt({ ...baseInput, memoryContext });
  assert.ok(
    !parts.static.includes("Durable memories"),
    "memory section must NOT appear in the cacheable static block",
  );
  assert.ok(
    !parts.static.includes("some memory"),
    "memory body must NOT appear in the cacheable static block",
  );
});

// ---- no-memory cases (no dangling heading) ---------------------

test("system-prompt: undefined memoryContext → no injection, no heading", () => {
  // Backward compatibility: callers that predate P16-D don't pass
  // `memoryContext`. The output must be identical to what it was
  // before the knob was added.
  const parts = buildSystemPrompt({ ...baseInput });
  assert.ok(
    !parts.dynamic.includes("Durable memories"),
    "no memory heading when memoryContext is undefined",
  );
});

test("system-prompt: empty-string memoryContext → no injection, no heading", () => {
  // The gather step's empty-signal is an empty string (renderer
  // contract). The builder must treat it the same as undefined —
  // no heading, no extra whitespace.
  const parts = buildSystemPrompt({ ...baseInput, memoryContext: "" });
  assert.ok(
    !parts.dynamic.includes("Durable memories"),
    "empty memoryContext must not inject anything",
  );
});

test("system-prompt: empty memoryContext keeps dynamic block shape stable", () => {
  // A more specific version of the previous pin — compare the
  // dynamic block with empty memoryContext to the dynamic block
  // with no key at all. They must be byte-identical so old tests
  // stay green.
  const withoutKey = buildSystemPrompt({ ...baseInput }).dynamic;
  const withEmpty = buildSystemPrompt({ ...baseInput, memoryContext: "" }).dynamic;
  assert.equal(withEmpty, withoutKey, "empty string must be indistinguishable from omission");
});

// ---- static block immutability --------------------------------

test("system-prompt: static block is unchanged whether memoryContext is set or not", () => {
  // Belt-and-braces: the cacheable block is byte-identical in
  // both cases. If this drifts, prompt caching breaks on every
  // turn.
  const withMem = buildSystemPrompt({
    ...baseInput,
    memoryContext: "### Durable memories\n- bullet",
  }).static;
  const withoutMem = buildSystemPrompt({ ...baseInput }).static;
  assert.equal(withMem, withoutMem, "static block must be identical regardless of memoryContext");
});

// ---- end-to-end shape for the injected case -------------------

test("system-prompt: full dynamic-block snapshot with memory injected", () => {
  // Pin the exact rendered layout so a silent whitespace regression
  // (e.g. missing blank line before tenant-context) is caught.
  const memoryContext = [
    "### Durable memories (team-scoped, operator-authored)",
    "safety posture line goes here",
    "",
    "#### Team: Ministry Events",
    "- [fact, 2025-10-15] example",
  ].join("\n");
  const parts = buildSystemPrompt({
    locale: "en",
    tenantContext: "## Tenant context (snapshot)\ntenant body",
    nowLocal: "Tuesday, October 21, 2025 at 09:00 AM",
    tz: "Asia/Riyadh",
    todayKey: "2025-10-21",
    memoryContext,
  });
  const expected = [
    "Interface locale: English (en). Reply in English unless the operator switches to Arabic.",
    "Now (local, Asia/Riyadh): Tuesday, October 21, 2025 at 09:00 AM. Local date key: 2025-10-21.",
    "",
    "### Durable memories (team-scoped, operator-authored)",
    "safety posture line goes here",
    "",
    "#### Team: Ministry Events",
    "- [fact, 2025-10-15] example",
    "",
    "## Tenant context (snapshot)",
    "tenant body",
  ].join("\n");
  assert.equal(parts.dynamic, expected);
});
