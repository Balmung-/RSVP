import { test } from "node:test";
import assert from "node:assert/strict";

import { selectResumeSessionId } from "../../src/components/chat/resumeLast";
import type { SessionListItem } from "../../src/app/api/chat/sessions/handler";

// P4-B — tests for the "pick newest session to resume" rule.
//
// What matters:
//   1. Happy path: with a well-formed, desc-sorted list from the
//      server, we pick index 0's id.
//   2. Defensive: if the list is empty / null / not an array, we
//      return null (caller leaves the workspace in fresh state).
//   3. Ordering defense: if a future middleware re-sorts the
//      response (alphabetical, by title), we still pick the
//      chronologically newest. The scan doesn't trust input order.
//   4. Malformed rows: a row with no id / no updatedAt / wrong
//      types is skipped; we don't crash, don't return a bad id.

function item(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "sess-1",
    title: "Example",
    createdAt: "2026-04-18T09:00:00Z",
    updatedAt: "2026-04-20T12:00:00Z",
    messageCount: 2,
    preview: null,
    ...overrides,
  };
}

// ---- Happy path --------------------------------------------------

test("selectResumeSessionId: returns index 0 id on a properly desc-sorted list", () => {
  const list: SessionListItem[] = [
    item({ id: "a", updatedAt: "2026-04-20T12:00:00Z" }),
    item({ id: "b", updatedAt: "2026-04-19T10:00:00Z" }),
    item({ id: "c", updatedAt: "2026-04-18T09:00:00Z" }),
  ];
  assert.equal(selectResumeSessionId(list), "a");
});

test("selectResumeSessionId: single-session list returns that session's id", () => {
  const list = [item({ id: "solo", updatedAt: "2026-04-20T12:00:00Z" })];
  assert.equal(selectResumeSessionId(list), "solo");
});

// ---- Empty / null / wrong-type ------------------------------------

test("selectResumeSessionId: empty list returns null", () => {
  assert.equal(selectResumeSessionId([]), null);
});

test("selectResumeSessionId: undefined returns null", () => {
  assert.equal(selectResumeSessionId(undefined), null);
});

test("selectResumeSessionId: null returns null", () => {
  assert.equal(selectResumeSessionId(null), null);
});

test("selectResumeSessionId: non-array returns null", () => {
  // Defensive — a fetch that returns `{sessions: "error"}` would
  // blow up a naive `list[0].id` access. The helper must survive.
  assert.equal(
    selectResumeSessionId("bad" as unknown as SessionListItem[]),
    null,
  );
  assert.equal(
    selectResumeSessionId({} as unknown as SessionListItem[]),
    null,
  );
});

// ---- Ordering defense --------------------------------------------

test("selectResumeSessionId: picks chronologically newest even if input is re-sorted (alphabetical by id)", () => {
  // Hypothetical future middleware that alphabetizes. The helper
  // must still pick the newest — otherwise the operator returning
  // to /chat would resume an OLDER session than the one they left.
  const list: SessionListItem[] = [
    item({ id: "a", updatedAt: "2026-04-18T09:00:00Z" }), // oldest, but first
    item({ id: "b", updatedAt: "2026-04-19T10:00:00Z" }),
    item({ id: "c", updatedAt: "2026-04-20T12:00:00Z" }), // newest, but last
  ];
  assert.equal(selectResumeSessionId(list), "c");
});

test("selectResumeSessionId: picks newest when multiple share exact updatedAt (first-wins tiebreak)", () => {
  // Two sessions touched within the same millisecond (possible
  // under high concurrency or clock resolution). Deterministic
  // first-seen-wins tiebreak keeps picker UX stable across reloads.
  const list: SessionListItem[] = [
    item({ id: "first", updatedAt: "2026-04-20T12:00:00Z" }),
    item({ id: "second", updatedAt: "2026-04-20T12:00:00Z" }),
  ];
  assert.equal(selectResumeSessionId(list), "first");
});

// ---- Malformed rows ----------------------------------------------

test("selectResumeSessionId: row with missing id is skipped, next valid row wins", () => {
  const list: SessionListItem[] = [
    { ...item({ updatedAt: "2026-04-20T12:00:00Z" }), id: undefined as unknown as string },
    item({ id: "b", updatedAt: "2026-04-19T10:00:00Z" }),
  ];
  assert.equal(selectResumeSessionId(list), "b");
});

test("selectResumeSessionId: row with empty-string id is skipped", () => {
  const list: SessionListItem[] = [
    item({ id: "", updatedAt: "2026-04-20T12:00:00Z" }),
    item({ id: "b", updatedAt: "2026-04-19T10:00:00Z" }),
  ];
  assert.equal(selectResumeSessionId(list), "b");
});

test("selectResumeSessionId: row with missing updatedAt is skipped", () => {
  const list: SessionListItem[] = [
    {
      ...item({ id: "a" }),
      updatedAt: undefined as unknown as string,
    },
    item({ id: "b", updatedAt: "2026-04-19T10:00:00Z" }),
  ];
  assert.equal(selectResumeSessionId(list), "b");
});

test("selectResumeSessionId: all rows malformed returns null", () => {
  const list: SessionListItem[] = [
    { ...item(), id: "" },
    { ...item(), updatedAt: "" },
  ];
  assert.equal(selectResumeSessionId(list), null);
});
