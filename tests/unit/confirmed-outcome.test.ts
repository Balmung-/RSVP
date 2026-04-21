import assert from "node:assert/strict";
import test from "node:test";

import { appendConfirmedOutcome } from "../../src/components/chat/confirmedOutcome";
import type { Turn } from "../../src/components/chat/types";

test("appendConfirmedOutcome appends a settled assistant turn with the summary text", () => {
  const prev: Turn[] = [{ kind: "user", id: "u1", text: "send it" }];

  const next = appendConfirmedOutcome(prev, {
    summary: "Sent 12 messages.",
    isError: false,
  });

  assert.equal(next.length, 2);
  assert.equal(next[0], prev[0]);
  assert.equal(next[1]?.kind, "assistant");
  if (next[1]?.kind !== "assistant") return;
  assert.equal(next[1].streaming, false);
  assert.equal(next[1].error, undefined);
  assert.deepEqual(next[1].blocks, [{ type: "text", text: "Sent 12 messages." }]);
});

test("appendConfirmedOutcome keeps refusal summaries transcript-shaped (text only, no synthetic error banner)", () => {
  const next = appendConfirmedOutcome([], {
    summary: "Import refused: nothing_to_commit",
    isError: true,
  });

  assert.equal(next.length, 1);
  assert.equal(next[0]?.kind, "assistant");
  if (next[0]?.kind !== "assistant") return;
  assert.equal(next[0].error, undefined);
  assert.deepEqual(next[0].blocks, [
    { type: "text", text: "Import refused: nothing_to_commit" },
  ]);
});

test("appendConfirmedOutcome ignores empty summaries", () => {
  const prev: Turn[] = [{ kind: "user", id: "u1", text: "x" }];
  assert.equal(
    appendConfirmedOutcome(prev, { summary: "", isError: false }),
    prev,
  );
  assert.equal(
    appendConfirmedOutcome(prev, { summary: "   ", isError: true }),
    prev,
  );
});
