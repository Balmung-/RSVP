import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideResumeAction,
  selectResumeSessionId,
  type ResumeDecisionInput,
} from "../../src/components/chat/resumeLast";
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

// ---- decideResumeAction — gate logic the effect uses ---------------
//
// Pinning these cases in a pure helper means the race conditions
// (draft vs. slow sessions fetch, URL session vs. resume, etc.) can
// be tested without a React harness. The effect that wraps this is a
// thin shell; if the pure decision is right, the effect is right.

function baseInput(
  overrides: Partial<ResumeDecisionInput> = {},
): ResumeDecisionInput {
  return {
    sessions: [item({ id: "newest", updatedAt: "2026-04-20T12:00:00Z" })],
    currentSessionId: null,
    turnCount: 0,
    draft: "",
    hasUrlSession: false,
    ...overrides,
  };
}

// ---- Happy path ----------------------------------------------------

test("decideResumeAction: clean fresh mount + populated list → resume newest", () => {
  const d = decideResumeAction(
    baseInput({
      sessions: [
        item({ id: "a", updatedAt: "2026-04-18T00:00:00Z" }),
        item({ id: "b", updatedAt: "2026-04-20T12:00:00Z" }),
      ],
    }),
  );
  assert.deepEqual(d, { action: "resume", sessionId: "b" });
});

// ---- Wait (sessions list not here yet) -----------------------------

test("decideResumeAction: empty sessions list → wait (NOT standdown)", () => {
  // Distinguishing wait from standdown is load-bearing: on initial
  // mount the fetch is still in flight, and flipping the latch here
  // would prevent the effect from firing again when the list lands.
  const d = decideResumeAction(baseInput({ sessions: [] }));
  assert.deepEqual(d, { action: "wait" });
});

test("decideResumeAction: undefined sessions → wait", () => {
  const d = decideResumeAction(baseInput({ sessions: undefined }));
  assert.deepEqual(d, { action: "wait" });
});

test("decideResumeAction: null sessions → wait", () => {
  const d = decideResumeAction(baseInput({ sessions: null }));
  assert.deepEqual(d, { action: "wait" });
});

// ---- The GPT blocker — draft-race gate -----------------------------

test("decideResumeAction: BLOCKER — non-empty draft → standdown, even with sessions present", () => {
  // The scenario GPT flagged on f2534f5:
  //   1. Operator lands on /chat, the sessions fetch is slow.
  //   2. Operator starts typing into the composer (`input` state).
  //   3. Sessions fetch resolves, effect re-fires.
  //   4. Without this gate, hydrateSession() would swap in an older
  //      session's turns/widgets, stranding the draft in `input`
  //      under the wrong session context.
  const d = decideResumeAction(baseInput({ draft: "Draft the Eid campaign" }));
  assert.deepEqual(d, { action: "standdown" });
});

test("decideResumeAction: draft with leading/trailing whitespace only → still treated as empty, resumes", () => {
  // "  \n  " is not an intentional draft — it's noise from an
  // accidental keypress or a paste that got trimmed. If we stood
  // down here we'd disable auto-resume permanently for any user
  // whose focus fires a stray space before /api/chat/sessions lands.
  const d = decideResumeAction(baseInput({ draft: "  \n  \t " }));
  assert.equal(d.action, "resume");
});

test("decideResumeAction: single non-whitespace character in draft → standdown", () => {
  // Minimum signal of operator intent — treat even one real char as
  // a draft worth protecting.
  const d = decideResumeAction(baseInput({ draft: "a" }));
  assert.deepEqual(d, { action: "standdown" });
});

test("decideResumeAction: draft present + sessions empty → standdown (draft wins over wait)", () => {
  // If the operator has typed, we should NOT keep waiting for
  // sessions — we should latch standdown so a later arrival can't
  // retroactively fire resume. Pin the precedence here.
  const d = decideResumeAction(
    baseInput({ draft: "hello", sessions: [] }),
  );
  assert.deepEqual(d, { action: "standdown" });
});

// ---- URL session already handling hydration ------------------------

test("decideResumeAction: hasUrlSession true → standdown (URL-hydrate wins)", () => {
  // When the URL has `?session=X`, the other mount effect hydrates
  // X directly. Resume-last must NOT fire a parallel hydrate.
  const d = decideResumeAction(baseInput({ hasUrlSession: true }));
  assert.deepEqual(d, { action: "standdown" });
});

// ---- Active session already set ------------------------------------

test("decideResumeAction: currentSessionId already non-null → standdown", () => {
  const d = decideResumeAction(
    baseInput({ currentSessionId: "already-picked" }),
  );
  assert.deepEqual(d, { action: "standdown" });
});

// ---- Turns already present -----------------------------------------

test("decideResumeAction: turnCount > 0 → standdown", () => {
  // The operator already sent a message on a fresh workspace.
  // Resume would wipe their fresh session's turns.
  const d = decideResumeAction(baseInput({ turnCount: 2 }));
  assert.deepEqual(d, { action: "standdown" });
});

// ---- List present but unusable -------------------------------------

test("decideResumeAction: sessions present but all malformed → standdown (not wait)", () => {
  // `wait` here would re-fire forever. Once we've determined the
  // list is populated but unusable, latch standdown.
  const bogus = [{ ...item(), id: "" }, { ...item(), updatedAt: "" }];
  const d = decideResumeAction(baseInput({ sessions: bogus }));
  assert.deepEqual(d, { action: "standdown" });
});

// ---- Precedence ordering -------------------------------------------

test("decideResumeAction: URL session precedes all other gates", () => {
  // Even if draft + turns + currentSessionId + empty list were all
  // clean, a URL session still forces standdown (URL-hydrate owns
  // that mount). Conversely, these non-URL gates should never
  // promote to "resume" when the URL is set.
  const d = decideResumeAction(
    baseInput({
      hasUrlSession: true,
      sessions: [item({ id: "x", updatedAt: "2026-04-20T12:00:00Z" })],
      draft: "",
      turnCount: 0,
      currentSessionId: null,
    }),
  );
  assert.deepEqual(d, { action: "standdown" });
});
