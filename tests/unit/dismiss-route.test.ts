import { test } from "node:test";
import assert from "node:assert/strict";
import type { User } from "@prisma/client";
import {
  dismissHandler,
  type DismissDeps,
  type DismissResult,
} from "../../src/app/api/chat/dismiss/handler";
import type { WidgetRow } from "../../src/lib/ai/widgets";

// Route-level tests for POST /api/chat/dismiss. They pin each
// branch of the dismiss decision tree:
//
//   - 401 unauthorized                   -> no session
//   - 429 rate_limited                   -> bucket exhausted; no DB read
//   - 400 bad_body                       -> not JSON / empty
//   - 400 bad_session_id                 -> missing / wrong type
//   - 400 bad_widget_key                 -> missing / wrong type
//   - 404 not_found                      -> widget missing or not owned
//                                           (foreign session collapses
//                                           to the same 404 — ownership
//                                           probe defence)
//   - 400 corrupt_row                    -> stored props JSON malformed
//                                           or schema-drift; refuse to
//                                           sweep a row we can't confirm
//                                           is a terminal confirm widget
//   - 400 not_dismissable (wrong kind)   -> live view widget
//                                           (campaign_list / campaign_card /
//                                           contact_table / activity_stream)
//   - 400 not_dismissable (ready state)  -> confirm_send not yet actioned
//   - 400 not_dismissable (submitting)   -> confirm_send mid-POST
//   - 200 ok (confirm_send done)         -> happy path, removeWidget called
//   - 200 ok (confirm_send error)        -> terminal error also dismissable
//   - 200 ok (confirm_draft done)        -> drafts are terminal-on-creation
//   - 200 ok (removed:false on race)     -> idempotent — removeWidget
//                                           returned false because a
//                                           concurrent dismiss won

// --- Fixtures ------------------------------------------------------

const USER: User = { id: "user-1" } as unknown as User;

function row(overrides: Partial<WidgetRow> = {}): WidgetRow {
  return {
    id: "row-1",
    sessionId: "sess-1",
    widgetKey: "confirm.send.campaign-1",
    kind: "confirm_send",
    slot: "action",
    // Default: a terminal-done confirm_send blob that passes
    // validateWidgetProps. The `result` + `state` pairing matches
    // what runConfirmSend writes on the happy path.
    props: JSON.stringify(fullConfirmSendProps("done")),
    order: 0,
    sourceMessageId: null,
    createdAt: new Date("2026-04-19T12:00:00Z"),
    updatedAt: new Date("2026-04-19T12:00:00Z"),
    ...overrides,
  };
}

// Build a confirm_send prop blob that passes validateWidgetProps
// for the given state. Terminal states carry result/error; pre-
// terminal states don't.
function fullConfirmSendProps(
  state: "ready" | "blocked" | "submitting" | "done" | "error",
): Record<string, unknown> {
  const base = {
    campaign_id: "campaign-1",
    name: "Eid reception",
    status: "scheduled",
    venue: null,
    event_at: null,
    locale: "en",
    channel: "email",
    only_unsent: true,
    invitee_total: 5,
    ready_messages: 5,
    by_channel: {
      email: {
        ready: 5,
        skipped_already_sent: 0,
        skipped_unsubscribed: 0,
        no_contact: 0,
      },
      sms: {
        ready: 0,
        skipped_already_sent: 0,
        skipped_unsubscribed: 0,
        no_contact: 0,
      },
    },
    template_preview: {
      subject_email: "Subject",
      email_body: "Body",
      sms_body: null,
    },
    blockers: [] as string[],
    state,
  } as Record<string, unknown>;
  if (state === "done") {
    base.result = { email: 5, sms: 0, skipped: 0, failed: 0 };
  } else if (state === "error") {
    base.error = "dispatch_failed";
  }
  return base;
}

function fullConfirmDraftProps(): Record<string, unknown> {
  return {
    id: "draft-1",
    name: "Draft name",
    description: null,
    venue: null,
    event_at: null,
    locale: "en",
    status: "draft",
    team_id: null,
    created_at: "2026-04-19T12:00:00Z",
    state: "done",
  };
}

// Capture-style deps factory. Each override carves off one branch
// without us having to redefine every port in every test.
function makeDeps(
  overrides: {
    user?: User | null;
    rateLimitOk?: boolean;
    findResult?: WidgetRow | null;
    removeResult?: { removed: boolean };
  } = {},
) {
  const findCalls: Array<{
    sessionId: string;
    widgetKey: string;
    userId: string;
  }> = [];
  const removeCalls: Array<{ sessionId: string; widgetKey: string }> = [];
  const rateLimitCalls: string[] = [];

  const user = overrides.user === undefined ? USER : overrides.user;
  const findResult =
    overrides.findResult === undefined ? row() : overrides.findResult;
  const removeResult = overrides.removeResult ?? { removed: true };
  const rateLimitOk =
    overrides.rateLimitOk === undefined ? true : overrides.rateLimitOk;

  const deps: DismissDeps = {
    getCurrentUser: async () => user,
    checkRateLimit: (userId) => {
      rateLimitCalls.push(userId);
      return rateLimitOk
        ? { ok: true, retryAfterMs: 0 }
        : { ok: false, retryAfterMs: 2000 };
    },
    findWidgetForUser: async (args) => {
      findCalls.push(args);
      return findResult;
    },
    removeWidget: async (sessionId, widgetKey) => {
      removeCalls.push({ sessionId, widgetKey });
      return removeResult;
    },
  };

  return { deps, findCalls, removeCalls, rateLimitCalls };
}

function jsonReq(obj: unknown): Request {
  return new Request("https://app.example.gov/api/chat/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  });
}

function rawReq(body: string, contentType = "application/json"): Request {
  return new Request("https://app.example.gov/api/chat/dismiss", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

function bodyOf(r: DismissResult): Record<string, unknown> {
  return r.body;
}

// --- Tests ---------------------------------------------------------

test("401 when no user — does not consume rate-limit or touch DB", async () => {
  const { deps, findCalls, removeCalls, rateLimitCalls } = makeDeps({
    user: null,
  });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: "confirm.send.c1" }),
    deps,
  );
  assert.equal(r.status, 401);
  assert.equal(bodyOf(r).error, "unauthorized");
  // An unauthenticated probe must not even reach the rate limiter
  // or the DB — otherwise an attacker could prime the bucket or
  // infer widget existence from timing.
  assert.deepEqual(rateLimitCalls, []);
  assert.deepEqual(findCalls, []);
  assert.deepEqual(removeCalls, []);
});

test("429 when rate-limited — includes retryAfterMs, no DB read", async () => {
  const { deps, findCalls, removeCalls } = makeDeps({ rateLimitOk: false });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: "confirm.send.c1" }),
    deps,
  );
  assert.equal(r.status, 429);
  const body = bodyOf(r);
  assert.equal(body.error, "rate_limited");
  assert.equal(body.retryAfterMs, 2000);
  // Short-circuit — don't do DB work for a throttled request.
  assert.deepEqual(findCalls, []);
  assert.deepEqual(removeCalls, []);
});

test("400 bad_body when body is not JSON", async () => {
  const { deps, findCalls } = makeDeps();
  const r = await dismissHandler(rawReq("not-json{{"), deps);
  assert.equal(r.status, 400);
  assert.equal(bodyOf(r).error, "bad_body");
  assert.deepEqual(findCalls, []);
});

test("400 bad_body when body is JSON null / non-object", async () => {
  const { deps } = makeDeps();
  const r = await dismissHandler(rawReq("null"), deps);
  assert.equal(r.status, 400);
  assert.equal(bodyOf(r).error, "bad_body");
});

test("400 bad_session_id when sessionId missing", async () => {
  const { deps, findCalls } = makeDeps();
  const r = await dismissHandler(
    jsonReq({ widgetKey: "confirm.send.c1" }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.equal(bodyOf(r).error, "bad_session_id");
  assert.deepEqual(findCalls, []);
});

test("400 bad_session_id when sessionId empty string", async () => {
  const { deps } = makeDeps();
  const r = await dismissHandler(
    jsonReq({ sessionId: "", widgetKey: "confirm.send.c1" }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.equal(bodyOf(r).error, "bad_session_id");
});

test("400 bad_widget_key when widgetKey missing", async () => {
  const { deps } = makeDeps();
  const r = await dismissHandler(jsonReq({ sessionId: "sess-1" }), deps);
  assert.equal(r.status, 400);
  assert.equal(bodyOf(r).error, "bad_widget_key");
});

test("400 bad_widget_key when widgetKey empty string", async () => {
  const { deps } = makeDeps();
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: "" }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.equal(bodyOf(r).error, "bad_widget_key");
});

test("404 not_found when widget lookup returns null — ownership or existence", async () => {
  // The lookup joins on session.userId. Foreign rows and missing
  // rows return the same null so a probe can't tell them apart.
  const { deps, findCalls, removeCalls } = makeDeps({ findResult: null });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: "confirm.send.unknown" }),
    deps,
  );
  assert.equal(r.status, 404);
  assert.equal(bodyOf(r).error, "not_found");
  assert.equal(findCalls.length, 1);
  assert.deepEqual(findCalls[0], {
    sessionId: "sess-1",
    widgetKey: "confirm.send.unknown",
    userId: USER.id,
  });
  // No delete attempted on a missing row.
  assert.deepEqual(removeCalls, []);
});

test("400 corrupt_row when stored props JSON is malformed", async () => {
  // rowToWidget returns null on JSON parse fail — we refuse
  // rather than sweep a row we can't confirm is terminal.
  const corrupt = row({ props: "{this is not json" });
  const { deps, removeCalls } = makeDeps({ findResult: corrupt });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: corrupt.widgetKey }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.equal(bodyOf(r).error, "corrupt_row");
  assert.deepEqual(removeCalls, []);
});

test("400 corrupt_row when stored props pass JSON but fail validator", async () => {
  // Schema drift: a valid JSON but wrong shape (missing required
  // fields). validateWidgetProps rejects; we refuse dismiss rather
  // than guess whether it's terminal.
  const drifted = row({ props: JSON.stringify({ state: "done" }) });
  const { deps, removeCalls } = makeDeps({ findResult: drifted });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: drifted.widgetKey }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.equal(bodyOf(r).error, "corrupt_row");
  assert.deepEqual(removeCalls, []);
});

test("400 not_dismissable when kind is a live-view widget (campaign_list)", async () => {
  const live = row({
    kind: "campaign_list",
    slot: "primary",
    widgetKey: "campaigns.list.all",
    props: JSON.stringify({
      items: [
        {
          id: "c1",
          name: "Campaign",
          status: "active",
          event_at: null,
          venue: null,
          team_id: null,
          stats: { total: 0, responded: 0, headcount: 0 },
        },
      ],
    }),
  });
  const { deps, removeCalls } = makeDeps({ findResult: live });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: live.widgetKey }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.equal(bodyOf(r).error, "not_dismissable");
  // Critically — we don't delete live views via this endpoint.
  assert.deepEqual(removeCalls, []);
});

test("400 not_dismissable when confirm_send is pre-terminal (ready)", async () => {
  const ready = row({
    props: JSON.stringify(fullConfirmSendProps("ready")),
  });
  const { deps, removeCalls } = makeDeps({ findResult: ready });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: ready.widgetKey }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.equal(bodyOf(r).error, "not_dismissable");
  // Dismissing a `ready` widget would throw away an unused
  // authorization anchor; server refuses.
  assert.deepEqual(removeCalls, []);
});

test("400 not_dismissable when confirm_send is submitting (mid-POST)", async () => {
  const submitting = row({
    props: JSON.stringify(fullConfirmSendProps("submitting")),
  });
  const { deps, removeCalls } = makeDeps({ findResult: submitting });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: submitting.widgetKey }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.equal(bodyOf(r).error, "not_dismissable");
  assert.deepEqual(removeCalls, []);
});

test("200 ok when confirm_send is terminal done — removeWidget called with correct args", async () => {
  const done = row({
    props: JSON.stringify(fullConfirmSendProps("done")),
  });
  const { deps, removeCalls } = makeDeps({ findResult: done });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: done.widgetKey }),
    deps,
  );
  assert.equal(r.status, 200);
  const body = bodyOf(r);
  assert.equal(body.ok, true);
  assert.equal(body.removed, true);
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(removeCalls[0], {
    sessionId: "sess-1",
    widgetKey: done.widgetKey,
  });
});

test("200 ok when confirm_send is terminal error — also dismissable", async () => {
  const errored = row({
    props: JSON.stringify(fullConfirmSendProps("error")),
  });
  const { deps, removeCalls } = makeDeps({ findResult: errored });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: errored.widgetKey }),
    deps,
  );
  assert.equal(r.status, 200);
  assert.equal(bodyOf(r).removed, true);
  assert.equal(removeCalls.length, 1);
});

test("200 ok when confirm_draft — drafts are terminal-on-creation", async () => {
  const draft = row({
    kind: "confirm_draft",
    widgetKey: "confirm.draft.draft-1",
    props: JSON.stringify(fullConfirmDraftProps()),
  });
  const { deps, removeCalls } = makeDeps({ findResult: draft });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: draft.widgetKey }),
    deps,
  );
  assert.equal(r.status, 200);
  assert.equal(bodyOf(r).removed, true);
  assert.equal(removeCalls.length, 1);
});

test("200 ok with removed:false when a concurrent dismiss already swept the row", async () => {
  // removeWidget returns `{removed: false}` when a parallel dismiss
  // won the race — the response forwards that honestly so the
  // client knows not to report a spurious error. Both tabs'
  // local state still converges to "widget gone" via their
  // respective widget_remove reducer calls.
  const done = row({
    props: JSON.stringify(fullConfirmSendProps("done")),
  });
  const { deps, removeCalls } = makeDeps({
    findResult: done,
    removeResult: { removed: false },
  });
  const r = await dismissHandler(
    jsonReq({ sessionId: "sess-1", widgetKey: done.widgetKey }),
    deps,
  );
  assert.equal(r.status, 200);
  const body = bodyOf(r);
  assert.equal(body.ok, true);
  assert.equal(body.removed, false);
  assert.equal(removeCalls.length, 1);
});
