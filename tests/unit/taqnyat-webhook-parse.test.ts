import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideDeliveryTransition,
  parseTaqnyatSmsDlr,
  parseTaqnyatWhatsAppDlr,
} from "../../src/lib/providers/taqnyat/webhooks";

// P12 — tests for Taqnyat's delivery-webhook parsers and the
// state-transition helper that decides when to touch Invitation rows.
//
// The parsers are the load-bearing seam: the route handler trusts
// whatever they return and writes it straight into the DB. Every
// shape of ambiguity — missing id, unknown status vocabulary,
// intermediate states Taqnyat also posts — has to be pinned.
//
// The transition helper enforces two invariants: delivered is sticky
// (no regression from terminal success), and idempotent replays
// don't cause duplicate EventLog rows.

// ---- SMS parser: happy paths -------------------------------------

test("parseTaqnyatSmsDlr: canonical shape → delivered + providerId + error string", () => {
  const r = parseTaqnyatSmsDlr({
    messageId: "msg-123",
    status: "delivered",
    statusDescription: "ok",
  });
  assert.deepEqual(r, {
    ok: true,
    providerId: "msg-123",
    status: "delivered",
    error: "ok",
  });
});

test("parseTaqnyatSmsDlr: uppercase status is case-insensitive", () => {
  // Taqnyat docs are inconsistent on casing; we normalize on parse
  // so the state-transition helper always sees lowercase vocabulary.
  const r = parseTaqnyatSmsDlr({ messageId: "m", status: "DELIVERED" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.status, "delivered");
});

test("parseTaqnyatSmsDlr: `id` field as fallback for providerId", () => {
  const r = parseTaqnyatSmsDlr({ id: "alt-id", status: "failed" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.providerId, "alt-id");
});

test("parseTaqnyatSmsDlr: `requestId` as second fallback for providerId", () => {
  const r = parseTaqnyatSmsDlr({ requestId: "req-id", status: "failed" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.providerId, "req-id");
});

test("parseTaqnyatSmsDlr: numeric providerId coerced to string", () => {
  // Some providers send numeric ids. Our Invitation.providerId is a
  // string, so we coerce at parse time rather than DB-layer.
  const r = parseTaqnyatSmsDlr({ messageId: 42, status: "delivered" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.providerId, "42");
});

test("parseTaqnyatSmsDlr: messageId wins over id/requestId when all present", () => {
  // Field precedence is messageId → id → requestId. A silent Taqnyat
  // schema change that adds a duplicate-but-different id field
  // shouldn't flip which key we use.
  const r = parseTaqnyatSmsDlr({
    messageId: "primary",
    id: "secondary",
    requestId: "tertiary",
    status: "delivered",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.providerId, "primary");
});

// ---- SMS parser: status vocabulary -------------------------------

test("parseTaqnyatSmsDlr: `failed` → failed", () => {
  const r = parseTaqnyatSmsDlr({ messageId: "m", status: "failed" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.status, "failed");
});

test("parseTaqnyatSmsDlr: `rejected` → failed", () => {
  const r = parseTaqnyatSmsDlr({ messageId: "m", status: "rejected" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.status, "failed");
});

test("parseTaqnyatSmsDlr: `expired` → bounced (permanent undeliverable)", () => {
  const r = parseTaqnyatSmsDlr({ messageId: "m", status: "expired" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.status, "bounced");
});

test("parseTaqnyatSmsDlr: `undelivered` → bounced", () => {
  const r = parseTaqnyatSmsDlr({ messageId: "m", status: "undelivered" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.status, "bounced");
});

test("parseTaqnyatSmsDlr: intermediate `sent` → ignore (not our state)", () => {
  // Taqnyat can fire multiple webhooks per send (sent → delivered, or
  // sent → failed). The `sent` one lands before the terminal one. We
  // don't update state on it — the send response already wrote `sent`.
  // `ignore` is NOT a 400 at the route level; it's a quiet 200 OK.
  const r = parseTaqnyatSmsDlr({ messageId: "m", status: "sent" });
  assert.deepEqual(r, { ok: false, reason: "ignore" });
});

test("parseTaqnyatSmsDlr: intermediate `accepted` → ignore", () => {
  const r = parseTaqnyatSmsDlr({ messageId: "m", status: "accepted" });
  assert.deepEqual(r, { ok: false, reason: "ignore" });
});

test("parseTaqnyatSmsDlr: intermediate `queued` → ignore", () => {
  const r = parseTaqnyatSmsDlr({ messageId: "m", status: "queued" });
  assert.deepEqual(r, { ok: false, reason: "ignore" });
});

test("parseTaqnyatSmsDlr: unrecognized status → failed with surfaced string", () => {
  // A vocabulary the provider added without telling us shouldn't
  // silently disappear. We mark the Invitation `failed` with the
  // original status string in the error field so ops can see it.
  const r = parseTaqnyatSmsDlr({ messageId: "m", status: "weirdstate" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /unrecognized status "weirdstate"/);
  }
});

// ---- SMS parser: error-text extraction ---------------------------

test("parseTaqnyatSmsDlr: surfaces statusDescription as error", () => {
  const r = parseTaqnyatSmsDlr({
    messageId: "m",
    status: "failed",
    statusDescription: "invalid recipient",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.error, "invalid recipient");
});

test("parseTaqnyatSmsDlr: surfaces top-level `error` when statusDescription absent", () => {
  const r = parseTaqnyatSmsDlr({
    messageId: "m",
    status: "failed",
    error: "handset blocked",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.error, "handset blocked");
});

test("parseTaqnyatSmsDlr: delivered with no error text → error null (not empty string)", () => {
  const r = parseTaqnyatSmsDlr({ messageId: "m", status: "delivered" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.error, null);
});

test("parseTaqnyatSmsDlr: long error text clamped to 500 chars", () => {
  // Invitation.error column is a String? — Prisma default maps to
  // `VARCHAR(191)` on MySQL in the old Prisma default, TEXT on
  // Postgres. We clamp at 500 chars as a belt-and-suspenders cap;
  // a DLR shouldn't carry a 10-KB error message, and if it does we
  // prefer a truncated audit to a failed write.
  const bigError = "x".repeat(2000);
  const r = parseTaqnyatSmsDlr({
    messageId: "m",
    status: "failed",
    error: bigError,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal((r.error ?? "").length, 500);
});

// ---- SMS parser: malformed input ---------------------------------

test("parseTaqnyatSmsDlr: null body → bad_json", () => {
  assert.deepEqual(parseTaqnyatSmsDlr(null), { ok: false, reason: "bad_json" });
});

test("parseTaqnyatSmsDlr: string body → bad_json", () => {
  assert.deepEqual(parseTaqnyatSmsDlr("garbage"), { ok: false, reason: "bad_json" });
});

test("parseTaqnyatSmsDlr: array body → bad_json", () => {
  // A defensive path — Taqnyat posts objects, not arrays, but a
  // misconfigured gateway might wrap the payload. Don't crash trying
  // to look up `.messageId` on an array.
  assert.deepEqual(parseTaqnyatSmsDlr([]), { ok: false, reason: "bad_json" });
});

test("parseTaqnyatSmsDlr: object with no id → bad_provider_id", () => {
  const r = parseTaqnyatSmsDlr({ status: "delivered" });
  assert.deepEqual(r, { ok: false, reason: "bad_provider_id" });
});

test("parseTaqnyatSmsDlr: empty-string messageId → bad_provider_id", () => {
  // Edge case: provider sends `messageId: ""` in a malformed payload.
  // Treat as missing — we can't look up Invitation by an empty key.
  const r = parseTaqnyatSmsDlr({ messageId: "", status: "delivered" });
  assert.deepEqual(r, { ok: false, reason: "bad_provider_id" });
});

test("parseTaqnyatSmsDlr: object with id but no status → bad_status", () => {
  const r = parseTaqnyatSmsDlr({ messageId: "m" });
  assert.deepEqual(r, { ok: false, reason: "bad_status" });
});

// ---- WhatsApp parser: happy paths --------------------------------

test("parseTaqnyatWhatsAppDlr: Meta envelope delivered → delivered + wamid", () => {
  const r = parseTaqnyatWhatsAppDlr({
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                { id: "wamid.ABC", status: "delivered", recipient_id: "966500000000" },
              ],
            },
          },
        ],
      },
    ],
  });
  assert.deepEqual(r, {
    ok: true,
    providerId: "wamid.ABC",
    status: "delivered",
    error: null,
  });
});

test("parseTaqnyatWhatsAppDlr: failed status surfaces nested errors[0].code + message", () => {
  // Meta's envelope for a failed send carries structured error detail.
  // The Invitation's error column should get enough context to diagnose
  // without chasing the provider dashboard.
  const r = parseTaqnyatWhatsAppDlr({
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                {
                  id: "wamid.XYZ",
                  status: "failed",
                  errors: [
                    { code: 131047, title: "Re-engagement", message: "session closed" },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.status, "failed");
    assert.equal(r.providerId, "wamid.XYZ");
    assert.match(r.error ?? "", /code=131047/);
    assert.match(r.error ?? "", /Re-engagement/);
    assert.match(r.error ?? "", /session closed/);
  }
});

test("parseTaqnyatWhatsAppDlr: failed with no nested errors array → error null", () => {
  // Meta SHOULD always carry `errors` for failed, but defensive: a
  // partial envelope shouldn't crash the parser.
  const r = parseTaqnyatWhatsAppDlr({
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [{ id: "wamid.Q", status: "failed" }],
            },
          },
        ],
      },
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.error, null);
});

// ---- WhatsApp parser: ignored states -----------------------------

test("parseTaqnyatWhatsAppDlr: `sent` state → ignore", () => {
  const r = parseTaqnyatWhatsAppDlr({
    entry: [
      { changes: [{ value: { statuses: [{ id: "w", status: "sent" }] } }] },
    ],
  });
  assert.deepEqual(r, { ok: false, reason: "ignore" });
});

test("parseTaqnyatWhatsAppDlr: `read` state → ignore (outside our three-state model)", () => {
  const r = parseTaqnyatWhatsAppDlr({
    entry: [
      { changes: [{ value: { statuses: [{ id: "w", status: "read" }] } }] },
    ],
  });
  assert.deepEqual(r, { ok: false, reason: "ignore" });
});

test("parseTaqnyatWhatsAppDlr: inbound message envelope (has `messages`, no `statuses`) → ignore", () => {
  // Meta's same webhook URL receives both delivery statuses and
  // inbound messages. Inbound is a separate route (not in P12).
  // Must not 400 — Taqnyat would keep retrying a non-2xx forever.
  const r = parseTaqnyatWhatsAppDlr({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ from: "966500000000", text: { body: "hi" } }],
            },
          },
        ],
      },
    ],
  });
  assert.deepEqual(r, { ok: false, reason: "ignore" });
});

test("parseTaqnyatWhatsAppDlr: unrecognized status → failed with surfaced string", () => {
  const r = parseTaqnyatWhatsAppDlr({
    entry: [
      {
        changes: [
          { value: { statuses: [{ id: "w", status: "newmetastate" }] } },
        ],
      },
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /unrecognized status "newmetastate"/);
  }
});

// ---- WhatsApp parser: malformed envelopes ------------------------

test("parseTaqnyatWhatsAppDlr: missing entry array → bad_json", () => {
  assert.deepEqual(parseTaqnyatWhatsAppDlr({}), { ok: false, reason: "bad_json" });
});

test("parseTaqnyatWhatsAppDlr: entry is not array → bad_json", () => {
  assert.deepEqual(
    parseTaqnyatWhatsAppDlr({ entry: "oops" }),
    { ok: false, reason: "bad_json" },
  );
});

test("parseTaqnyatWhatsAppDlr: empty entry array → bad_json", () => {
  assert.deepEqual(
    parseTaqnyatWhatsAppDlr({ entry: [] }),
    { ok: false, reason: "bad_json" },
  );
});

test("parseTaqnyatWhatsAppDlr: entry[0].changes missing → bad_json", () => {
  assert.deepEqual(
    parseTaqnyatWhatsAppDlr({ entry: [{}] }),
    { ok: false, reason: "bad_json" },
  );
});

test("parseTaqnyatWhatsAppDlr: change.value missing → bad_json", () => {
  assert.deepEqual(
    parseTaqnyatWhatsAppDlr({ entry: [{ changes: [{}] }] }),
    { ok: false, reason: "bad_json" },
  );
});

test("parseTaqnyatWhatsAppDlr: value with neither statuses nor messages → bad_json", () => {
  // An envelope that's structurally valid but empty of both payload
  // types is a provider bug or malformed test fixture. 400.
  assert.deepEqual(
    parseTaqnyatWhatsAppDlr({
      entry: [{ changes: [{ value: {} }] }],
    }),
    { ok: false, reason: "bad_json" },
  );
});

test("parseTaqnyatWhatsAppDlr: status entry missing id → bad_provider_id", () => {
  const r = parseTaqnyatWhatsAppDlr({
    entry: [
      { changes: [{ value: { statuses: [{ status: "delivered" }] } }] },
    ],
  });
  assert.deepEqual(r, { ok: false, reason: "bad_provider_id" });
});

test("parseTaqnyatWhatsAppDlr: status entry missing status → bad_status", () => {
  const r = parseTaqnyatWhatsAppDlr({
    entry: [{ changes: [{ value: { statuses: [{ id: "w" }] } }] }],
  });
  assert.deepEqual(r, { ok: false, reason: "bad_status" });
});

// ---- State-transition helper -------------------------------------

const NOW = new Date("2026-04-20T12:00:00Z");
const DELIVERED_AT = new Date("2026-04-20T11:30:00Z");

test("decideDeliveryTransition: queued → delivered writes status + deliveredAt=now", () => {
  // Happy path: DLR lands before the sent-response write happens
  // (possible on very fast carriers). Status flips from its seed
  // "queued" straight to delivered.
  const d = decideDeliveryTransition(
    { status: "queued", deliveredAt: null },
    { status: "delivered", error: null },
    NOW,
  );
  assert.deepEqual(d, {
    shouldUpdate: true,
    nextStatus: "delivered",
    nextError: null,
    nextDeliveredAt: NOW,
  });
});

test("decideDeliveryTransition: sent → delivered writes delivered + deliveredAt=now", () => {
  // The most common transition — send path wrote `sent`, DLR writes
  // delivered.
  const d = decideDeliveryTransition(
    { status: "sent", deliveredAt: null },
    { status: "delivered", error: null },
    NOW,
  );
  assert.equal(d.shouldUpdate, true);
  if (d.shouldUpdate) {
    assert.equal(d.nextStatus, "delivered");
    assert.equal(d.nextDeliveredAt, NOW);
  }
});

test("decideDeliveryTransition: sent → failed writes failed + error + preserves deliveredAt", () => {
  const d = decideDeliveryTransition(
    { status: "sent", deliveredAt: null },
    { status: "failed", error: "carrier reject" },
    NOW,
  );
  assert.equal(d.shouldUpdate, true);
  if (d.shouldUpdate) {
    assert.equal(d.nextStatus, "failed");
    assert.equal(d.nextError, "carrier reject");
    // A failure transition must NOT stamp deliveredAt.
    assert.equal(d.nextDeliveredAt, null);
  }
});

test("decideDeliveryTransition: sent → bounced keeps deliveredAt null", () => {
  const d = decideDeliveryTransition(
    { status: "sent", deliveredAt: null },
    { status: "bounced", error: "expired" },
    NOW,
  );
  assert.equal(d.shouldUpdate, true);
  if (d.shouldUpdate) {
    assert.equal(d.nextStatus, "bounced");
    assert.equal(d.nextDeliveredAt, null);
  }
});

// ---- Idempotency & regression guards -----------------------------

test("decideDeliveryTransition: delivered → delivered is a no-op (idempotent replay)", () => {
  // Taqnyat can retry the same DLR if they don't get a 2xx. The
  // second delivery must NOT write — duplicate EventLog rows are
  // ops noise.
  const d = decideDeliveryTransition(
    { status: "delivered", deliveredAt: DELIVERED_AT },
    { status: "delivered", error: null },
    NOW,
  );
  assert.deepEqual(d, { shouldUpdate: false });
});

test("decideDeliveryTransition: delivered → failed is a no-op (regression guard)", () => {
  // A late DLR for a pre-delivery retry attempt whose original
  // message was eventually delivered by the carrier. Must NOT
  // overwrite the terminal success.
  const d = decideDeliveryTransition(
    { status: "delivered", deliveredAt: DELIVERED_AT },
    { status: "failed", error: "retry timeout" },
    NOW,
  );
  assert.deepEqual(d, { shouldUpdate: false });
});

test("decideDeliveryTransition: delivered → bounced is a no-op (regression guard)", () => {
  const d = decideDeliveryTransition(
    { status: "delivered", deliveredAt: DELIVERED_AT },
    { status: "bounced", error: "expired" },
    NOW,
  );
  assert.deepEqual(d, { shouldUpdate: false });
});

test("decideDeliveryTransition: failed → failed is a no-op (idempotent replay)", () => {
  const d = decideDeliveryTransition(
    { status: "failed", deliveredAt: null },
    { status: "failed", error: "carrier reject" },
    NOW,
  );
  assert.deepEqual(d, { shouldUpdate: false });
});

test("decideDeliveryTransition: bounced → bounced is a no-op", () => {
  const d = decideDeliveryTransition(
    { status: "bounced", deliveredAt: null },
    { status: "bounced", error: "unknown number" },
    NOW,
  );
  assert.deepEqual(d, { shouldUpdate: false });
});

test("decideDeliveryTransition: failed → delivered is ALLOWED (carrier recovery)", () => {
  // Rare but possible: carrier retried under the hood and actually
  // delivered after our initial `failed` write. We accept the
  // recovery path — delivered is the truth state we want.
  const d = decideDeliveryTransition(
    { status: "failed", deliveredAt: null },
    { status: "delivered", error: null },
    NOW,
  );
  assert.equal(d.shouldUpdate, true);
  if (d.shouldUpdate) {
    assert.equal(d.nextStatus, "delivered");
    assert.equal(d.nextDeliveredAt, NOW);
  }
});

test("decideDeliveryTransition: bounced → failed ALLOWED (cross-terminal correction)", () => {
  // Cross-terminal corrections are rare but non-regressive — neither
  // failed nor bounced is the "success" endpoint, so we allow the
  // state to reflect whatever DLR the provider pushed last.
  const d = decideDeliveryTransition(
    { status: "bounced", deliveredAt: null },
    { status: "failed", error: "late reclassification" },
    NOW,
  );
  assert.equal(d.shouldUpdate, true);
  if (d.shouldUpdate) assert.equal(d.nextStatus, "failed");
});
