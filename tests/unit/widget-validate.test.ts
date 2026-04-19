import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PROPS_JSON_BYTES,
  MAX_WIDGET_KEY_LEN,
  validateWidget,
  validateWidgetProps,
  WIDGET_KINDS,
  WIDGET_SLOTS,
} from "../../src/lib/ai/widget-validate";

// Guards the W1 widget persistence contract.
//
// `ChatWidget` rows live in the DB keyed by (sessionId, widgetKey)
// and are rendered by the workspace dashboard on reload. Two trust
// decisions hinge on this validator:
//
//   (a) WRITE gate: `upsertWidget` calls `validateWidget` before
//       touching Prisma. A malformed envelope / bad prop shape /
//       oversized blob / unknown kind returns null, the upsert is
//       skipped, and nothing bad lands in the DB.
//   (b) READ gate: `rowToWidget` calls `validateWidgetProps(kind,
//       parsed)` to defend against schema drift between write and
//       read. Drifted rows are silently dropped from the snapshot.
//
// Tests below mirror the directive-validate.ts pattern — happy path
// per kind, plus envelope-level and size-cap rejections. The two
// validators share prop shapes today because W3 migrates directives
// to widgets 1:1; keeping the test coverage independent protects
// the widget path from future divergence.

// ---- envelope / widgetKey ----

test("validateWidget: rejects non-object input", () => {
  assert.equal(validateWidget(null), null);
  assert.equal(validateWidget(undefined), null);
  assert.equal(validateWidget("widget"), null);
  assert.equal(validateWidget(42), null);
  assert.equal(validateWidget([]), null);
});

test("validateWidget: rejects missing / empty / whitespace widgetKey", () => {
  const base = {
    kind: "campaign_list",
    slot: "primary",
    props: { items: [] },
  };
  assert.equal(validateWidget({ ...base }), null, "missing widgetKey");
  assert.equal(validateWidget({ widgetKey: "", ...base }), null, "empty");
  assert.equal(
    validateWidget({ widgetKey: "   \t  ", ...base }),
    null,
    "whitespace-only",
  );
  assert.equal(
    validateWidget({ widgetKey: 42 as unknown as string, ...base }),
    null,
    "numeric",
  );
});

test("validateWidget: rejects widgetKey longer than MAX_WIDGET_KEY_LEN", () => {
  const tooLong = "a".repeat(MAX_WIDGET_KEY_LEN + 1);
  assert.equal(
    validateWidget({
      widgetKey: tooLong,
      kind: "campaign_list",
      slot: "primary",
      props: { items: [] },
    }),
    null,
  );
});

test("validateWidget: rejects unknown kind", () => {
  assert.equal(
    validateWidget({
      widgetKey: "x",
      kind: "some_future_kind",
      slot: "primary",
      props: {},
    }),
    null,
  );
});

test("validateWidget: rejects unknown slot", () => {
  assert.equal(
    validateWidget({
      widgetKey: "x",
      kind: "campaign_list",
      slot: "sidebar", // not in WIDGET_SLOTS
      props: { items: [] },
    }),
    null,
  );
});

test("validateWidget: rejects non-object props", () => {
  const base = { widgetKey: "x", kind: "campaign_list", slot: "primary" };
  assert.equal(validateWidget({ ...base, props: null }), null);
  assert.equal(validateWidget({ ...base, props: "oops" }), null);
  assert.equal(validateWidget({ ...base, props: [] }), null);
});

// ---- size cap ----

test("validateWidget: rejects props JSON larger than MAX_PROPS_JSON_BYTES", () => {
  // Build a campaign_list with enough junk string content to bust
  // the cap. The props still match the shape; only the size is bad.
  const bigName = "x".repeat(MAX_PROPS_JSON_BYTES + 10);
  const input = {
    widgetKey: "big",
    kind: "campaign_list",
    slot: "primary",
    props: {
      items: [
        {
          id: "c-1",
          name: bigName,
          status: "active",
          event_at: null,
          venue: null,
          team_id: null,
          stats: { total: 0, responded: 0, headcount: 0 },
        },
      ],
    },
  };
  assert.equal(validateWidget(input), null);
});

test("validateWidget: counts bytes via UTF-8 not string.length", () => {
  // A single 4-byte emoji would trick string.length into reporting
  // ~2 but Buffer.byteLength reports 4. If the cap were computed on
  // .length we could over-accept. Verify the cap holds on multi-byte
  // content by constructing a payload whose UTF-8 byte count lands
  // just above the cap but whose .length is well below.
  const emoji = "🇸🇦"; // 8 bytes in UTF-8, 4 in .length (surrogate pair × 2)
  const chunk = emoji.repeat(Math.ceil((MAX_PROPS_JSON_BYTES + 1024) / 8));
  const input = {
    widgetKey: "utf8",
    kind: "campaign_list",
    slot: "primary",
    props: {
      items: [
        {
          id: "c-1",
          name: chunk,
          status: "active",
          event_at: null,
          venue: null,
          team_id: null,
          stats: { total: 0, responded: 0, headcount: 0 },
        },
      ],
    },
  };
  assert.equal(validateWidget(input), null);
});

test("validateWidget: rejects cyclic props object", () => {
  // JSON.stringify throws TypeError on cycles — validateWidget must
  // catch, not propagate, so a buggy tool doesn't crash the chat
  // stream with a 500.
  const cyclic: Record<string, unknown> = { items: [] };
  cyclic.self = cyclic;
  assert.equal(
    validateWidget({
      widgetKey: "cycle",
      kind: "campaign_list",
      slot: "primary",
      props: cyclic,
    }),
    null,
  );
});

// ---- order / sourceMessageId ----

test("validateWidget: accepts omitted order / sourceMessageId", () => {
  const out = validateWidget({
    widgetKey: "x",
    kind: "campaign_list",
    slot: "primary",
    props: { items: [] },
  });
  assert.ok(out);
  assert.equal(out?.order, undefined);
  assert.equal(out?.sourceMessageId, undefined);
});

test("validateWidget: accepts explicit integer order", () => {
  const out = validateWidget({
    widgetKey: "x",
    kind: "campaign_list",
    slot: "primary",
    props: { items: [] },
    order: 3,
  });
  assert.equal(out?.order, 3);
});

test("validateWidget: rejects non-integer / non-finite order", () => {
  const base = {
    widgetKey: "x",
    kind: "campaign_list",
    slot: "primary",
    props: { items: [] },
  };
  assert.equal(validateWidget({ ...base, order: 1.5 }), null, "fractional");
  assert.equal(validateWidget({ ...base, order: NaN }), null, "NaN");
  assert.equal(validateWidget({ ...base, order: Infinity }), null, "Infinity");
  assert.equal(
    validateWidget({ ...base, order: "3" as unknown as number }),
    null,
    "string",
  );
});

test("validateWidget: accepts sourceMessageId null / string, normalises empty", () => {
  const base = {
    widgetKey: "x",
    kind: "campaign_list",
    slot: "primary",
    props: { items: [] },
  };
  const withNull = validateWidget({ ...base, sourceMessageId: null });
  assert.equal(withNull?.sourceMessageId, null);

  const withId = validateWidget({ ...base, sourceMessageId: "m-1" });
  assert.equal(withId?.sourceMessageId, "m-1");

  // Empty string normalises to null so callers don't hand Prisma a
  // value that would fail an FK lookup with "record not found".
  const withEmpty = validateWidget({ ...base, sourceMessageId: "" });
  assert.equal(withEmpty?.sourceMessageId, null);
});

test("validateWidget: rejects sourceMessageId of wrong type", () => {
  assert.equal(
    validateWidget({
      widgetKey: "x",
      kind: "campaign_list",
      slot: "primary",
      props: { items: [] },
      sourceMessageId: 42 as unknown as string,
    }),
    null,
  );
});

// ---- closed-set exports ----

test("validateWidget: WIDGET_KINDS matches the shipped dashboard + rollup kinds", () => {
  // The W3 migration lives or dies by these two sets staying
  // aligned. If someone adds a new directive kind without widening
  // WIDGET_KINDS (or vice versa), the migration will silently lose
  // surfaces. Pin the expected set here so a change in either file
  // fails review until both are updated.
  //
  // W7 sub-slice 2 added `workspace_rollup` — server-owned summary
  // widget, no directive twin (no tool emits this kind). It lives in
  // the widget registry because it's persisted like every other
  // widget, but the directive-validate registry stays at six; the
  // two sets deliberately diverge from this push onward.
  assert.deepEqual(
    [...WIDGET_KINDS].sort(),
    [
      "activity_stream",
      "campaign_card",
      "campaign_list",
      "confirm_draft",
      "confirm_send",
      "contact_table",
      "workspace_rollup",
    ],
  );
});

test("validateWidget: WIDGET_SLOTS matches the W2 dashboard regions", () => {
  assert.deepEqual(
    [...WIDGET_SLOTS].sort(),
    ["action", "primary", "secondary", "summary"],
  );
});

// ---- per-kind happy path ----
//
// One minimum-shape pass per kind. The point is to prove the widget
// validator accepts the exact same prop shapes the directive
// validator accepts — identical test inputs, same expected pass.
// If a future tweak to one drifts from the other, this suite goes
// red at commit time.

test("validateWidget: campaign_list minimum shape passes", () => {
  const out = validateWidget({
    widgetKey: "campaign_list:active",
    kind: "campaign_list",
    slot: "primary",
    props: {
      items: [
        {
          id: "c-1",
          name: "Eid reception",
          status: "active",
          event_at: null,
          venue: null,
          team_id: null,
          stats: { total: 100, responded: 40, headcount: 55 },
        },
      ],
    },
  });
  assert.ok(out);
  assert.equal(out?.kind, "campaign_list");
  assert.equal(out?.slot, "primary");
});

test("validateWidget: campaign_card minimum shape passes", () => {
  const out = validateWidget({
    widgetKey: "campaign_card:c-1",
    kind: "campaign_card",
    slot: "primary",
    props: {
      id: "c-1",
      name: "Eid reception",
      description: null,
      status: "active",
      event_at: null,
      venue: null,
      locale: "en",
      team_id: null,
      created_at: "2026-04-10T00:00:00Z",
      updated_at: "2026-04-11T00:00:00Z",
      stats: {
        total: 100,
        responded: 40,
        pending: 60,
        attending: 35,
        declined: 5,
        guests: 10,
        headcount: 55,
        sentEmail: 95,
        sentSms: 40,
      },
      activity: [],
    },
  });
  assert.ok(out);
});

test("validateWidget: contact_table minimum shape passes", () => {
  const out = validateWidget({
    widgetKey: "contacts:royal",
    kind: "contact_table",
    slot: "primary",
    props: {
      items: [],
      total: 0,
    },
  });
  assert.ok(out);
});

test("validateWidget: activity_stream minimum shape passes", () => {
  const out = validateWidget({
    widgetKey: "activity:latest",
    kind: "activity_stream",
    slot: "secondary",
    props: {
      items: [
        {
          id: "e-1",
          created_at: "2026-04-11T10:00:00Z",
          kind: "invite.sent",
          ref_type: null,
          ref_id: null,
          tone: "success",
          line: "Invitations sent.",
          actor: null,
        },
      ],
    },
  });
  assert.ok(out);
});

test("validateWidget: confirm_draft minimum shape passes", () => {
  const out = validateWidget({
    widgetKey: "confirm_draft:c-1",
    kind: "confirm_draft",
    slot: "action",
    props: {
      id: "c-1",
      name: "New draft",
      description: null,
      venue: null,
      event_at: null,
      locale: "en",
      status: "draft",
      team_id: null,
      created_at: "2026-04-19T00:00:00Z",
      state: "done",
    },
  });
  assert.ok(out);
});

test("validateWidget: confirm_send minimum shape (ready) passes", () => {
  const out = validateWidget({
    widgetKey: "confirm_send:c-1",
    kind: "confirm_send",
    slot: "action",
    props: {
      campaign_id: "c-1",
      name: "Eid reception",
      status: "active",
      venue: null,
      event_at: null,
      locale: "en",
      channel: "both",
      only_unsent: true,
      invitee_total: 40,
      ready_messages: 72,
      by_channel: {
        email: {
          ready: 40,
          skipped_already_sent: 0,
          skipped_unsubscribed: 0,
          no_contact: 0,
        },
        sms: {
          ready: 32,
          skipped_already_sent: 0,
          skipped_unsubscribed: 0,
          no_contact: 8,
        },
      },
      template_preview: {
        subject_email: "Invitation",
        email_body: "Body...",
        sms_body: null,
      },
      blockers: [],
      state: "ready",
    },
  });
  assert.ok(out);
});

// ---- per-kind shape rejection (one per kind; cheap drift catcher) ----

test("validateWidget: campaign_list — rejects item missing stats", () => {
  assert.equal(
    validateWidget({
      widgetKey: "campaign_list:active",
      kind: "campaign_list",
      slot: "primary",
      props: {
        items: [
          {
            id: "c-1",
            name: "x",
            status: "active",
            event_at: null,
            venue: null,
            team_id: null,
            // stats missing
          },
        ],
      },
    }),
    null,
  );
});

test("validateWidget: contact_table — rejects unknown vip_tier", () => {
  assert.equal(
    validateWidget({
      widgetKey: "contacts:royal",
      kind: "contact_table",
      slot: "primary",
      props: {
        items: [
          {
            id: "k-1",
            full_name: "X",
            title: null,
            organization: null,
            email: null,
            phone_e164: null,
            vip_tier: "emperor" as unknown as "royal",
            vip_label: "Emperor",
            tags: null,
            archived_at: null,
            invitee_count: 0,
          },
        ],
        total: 1,
      },
    }),
    null,
  );
});

test("validateWidget: confirm_send — rejects unknown channel", () => {
  assert.equal(
    validateWidget({
      widgetKey: "confirm_send:c-1",
      kind: "confirm_send",
      slot: "action",
      props: {
        campaign_id: "c-1",
        name: "x",
        status: "draft",
        venue: null,
        event_at: null,
        locale: "en",
        channel: "carrier-pigeon" as unknown as "both",
        only_unsent: true,
        invitee_total: 0,
        ready_messages: 0,
        by_channel: {
          email: {
            ready: 0,
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
          subject_email: null,
          email_body: null,
          sms_body: null,
        },
        blockers: [],
        state: "ready",
      },
    }),
    null,
  );
});

// ---- W5 state machine ----
//
// The confirm_send widget carries a persisted `state` that drives the
// renderer and must survive a reload. Its relationship with `result`
// and `error` is tight: the two terminal states each require their
// own payload, and pre-terminal states must not carry either. The
// validator is the last line of defence against a drifted blob in
// the DB reaching the renderer.

// Builds a minimum-shape confirm_send widget input, with `state`
// overridable per test. Keeps the per-test fixtures short without
// duplicating the 20-line shape.
function buildConfirmSend(extra: Record<string, unknown>) {
  return {
    widgetKey: "confirm_send:c-1",
    kind: "confirm_send",
    slot: "action",
    props: {
      campaign_id: "c-1",
      name: "Eid reception",
      status: "active",
      venue: null,
      event_at: null,
      locale: "en",
      channel: "both",
      only_unsent: true,
      invitee_total: 40,
      ready_messages: 72,
      by_channel: {
        email: {
          ready: 40,
          skipped_already_sent: 0,
          skipped_unsubscribed: 0,
          no_contact: 0,
        },
        sms: {
          ready: 32,
          skipped_already_sent: 0,
          skipped_unsubscribed: 0,
          no_contact: 8,
        },
      },
      template_preview: {
        subject_email: null,
        email_body: null,
        sms_body: null,
      },
      blockers: [],
      ...extra,
    },
  };
}

test("validateWidget: confirm_send — rejects missing state", () => {
  // Shape is otherwise valid; omitting `state` must fail so the
  // renderer always has a defined state to switch on.
  assert.equal(validateWidget(buildConfirmSend({})), null);
});

test("validateWidget: confirm_send — rejects unknown state value", () => {
  assert.equal(
    validateWidget(buildConfirmSend({ state: "totally-new" })),
    null,
  );
});

test("validateWidget: confirm_send — accepts each pre-terminal state", () => {
  for (const state of ["ready", "blocked", "submitting"] as const) {
    assert.ok(validateWidget(buildConfirmSend({ state })), `state=${state}`);
  }
});

test("validateWidget: confirm_send — rejects pre-terminal with result", () => {
  // A `ready` preview must not carry post-dispatch counters. The
  // route only writes `result` on the `done` transition, so a blob
  // mixing the two means something wrote in the wrong order.
  assert.equal(
    validateWidget(
      buildConfirmSend({
        state: "ready",
        result: { email: 1, sms: 1, skipped: 0, failed: 0 },
      }),
    ),
    null,
  );
});

test("validateWidget: confirm_send — rejects pre-terminal with error", () => {
  assert.equal(
    validateWidget(buildConfirmSend({ state: "blocked", error: "boom" })),
    null,
  );
});

test("validateWidget: confirm_send — done accepts result + optional summary", () => {
  const out = validateWidget(
    buildConfirmSend({
      state: "done",
      result: { email: 40, sms: 32, skipped: 5, failed: 0 },
      summary: "Sent 72: 40 email, 32 sms.",
    }),
  );
  assert.ok(out);
});

test("validateWidget: confirm_send — done requires result", () => {
  assert.equal(
    validateWidget(buildConfirmSend({ state: "done" })),
    null,
  );
});

test("validateWidget: confirm_send — done rejects co-present error", () => {
  // done is success; error must be absent. A blob with both fields
  // is inconsistent and the renderer shouldn't have to guess.
  assert.equal(
    validateWidget(
      buildConfirmSend({
        state: "done",
        result: { email: 1, sms: 0, skipped: 0, failed: 0 },
        error: "should not be here",
      }),
    ),
    null,
  );
});

test("validateWidget: confirm_send — done rejects non-finite result counters", () => {
  // NaN/Infinity could sneak through a naive numeric coerce. The
  // validator's `isFiniteNumber` guards against that; pin here.
  assert.equal(
    validateWidget(
      buildConfirmSend({
        state: "done",
        result: { email: Number.NaN, sms: 0, skipped: 0, failed: 0 },
      }),
    ),
    null,
  );
  assert.equal(
    validateWidget(
      buildConfirmSend({
        state: "done",
        result: {
          email: 1,
          sms: 1,
          skipped: Number.POSITIVE_INFINITY,
          failed: 0,
        },
      }),
    ),
    null,
  );
});

test("validateWidget: confirm_send — error accepts non-empty error string", () => {
  const out = validateWidget(
    buildConfirmSend({
      state: "error",
      error: "send_in_flight",
      summary: "Refused: a send is already in flight.",
    }),
  );
  assert.ok(out);
});

test("validateWidget: confirm_send — error requires non-empty error", () => {
  assert.equal(
    validateWidget(buildConfirmSend({ state: "error" })),
    null,
    "missing error",
  );
  assert.equal(
    validateWidget(buildConfirmSend({ state: "error", error: "" })),
    null,
    "empty error",
  );
});

test("validateWidget: confirm_send — error rejects co-present result", () => {
  assert.equal(
    validateWidget(
      buildConfirmSend({
        state: "error",
        error: "boom",
        result: { email: 0, sms: 0, skipped: 0, failed: 0 },
      }),
    ),
    null,
  );
});

test("validateWidget: confirm_draft — rejects missing state", () => {
  // Drafts are terminal-on-creation, so a missing state field means
  // the tool forgot to stamp "done" — fail closed.
  assert.equal(
    validateWidget({
      widgetKey: "confirm_draft:c-1",
      kind: "confirm_draft",
      slot: "action",
      props: {
        id: "c-1",
        name: "New draft",
        description: null,
        venue: null,
        event_at: null,
        locale: "en",
        status: "draft",
        team_id: null,
        created_at: "2026-04-19T00:00:00Z",
      },
    }),
    null,
  );
});

test("validateWidget: confirm_draft — rejects non-done state", () => {
  // There is no POST flow for drafts; the only valid state is "done".
  // If a future tool tries to emit a pre-terminal draft, this guard
  // forces the design change through a validator update first.
  for (const state of ["ready", "blocked", "submitting", "error"] as const) {
    assert.equal(
      validateWidget({
        widgetKey: "confirm_draft:c-1",
        kind: "confirm_draft",
        slot: "action",
        props: {
          id: "c-1",
          name: "New draft",
          description: null,
          venue: null,
          event_at: null,
          locale: "en",
          status: "draft",
          team_id: null,
          created_at: "2026-04-19T00:00:00Z",
          state,
        },
      }),
      null,
      `state=${state} must reject`,
    );
  }
});

// ---- identity preservation on pass ----

test("validateWidget: on pass, returned props is the same reference", () => {
  const props = {
    items: [
      {
        id: "c-1",
        name: "Eid",
        status: "active",
        event_at: null,
        venue: null,
        team_id: null,
        stats: { total: 1, responded: 0, headcount: 0 },
      },
    ],
  };
  const out = validateWidget({
    widgetKey: "x",
    kind: "campaign_list",
    slot: "primary",
    props,
  });
  assert.ok(out);
  // "validate, don't rewrite" — same reference, no clone.
  assert.equal(out?.props, props);
});

// ---- validateWidgetProps (read-path narrow helper) ----

test("validateWidgetProps: accepts known kind + shape-valid props", () => {
  assert.ok(validateWidgetProps("campaign_list", { items: [] }));
});

test("validateWidgetProps: rejects unknown kind", () => {
  assert.equal(validateWidgetProps("unknown_future", { items: [] }), false);
});

test("validateWidgetProps: rejects non-object props", () => {
  assert.equal(validateWidgetProps("campaign_list", null), false);
  assert.equal(validateWidgetProps("campaign_list", "oops"), false);
  assert.equal(validateWidgetProps("campaign_list", []), false);
});

test("validateWidgetProps: rejects shape-invalid props", () => {
  // campaign_list requires items array; missing items -> reject.
  assert.equal(validateWidgetProps("campaign_list", {}), false);
});
