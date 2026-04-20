import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handleTaqnyatDeliveryWebhook,
  type InvitationRow,
  type TaqnyatWebhookDeps,
} from "../../src/app/api/webhooks/taqnyat/delivery/handler";
import {
  parseTaqnyatSmsDlr,
  parseTaqnyatWhatsAppDlr,
} from "../../src/lib/providers/taqnyat/webhooks";

// P12 — route-level tests for the Taqnyat delivery webhook handler.
//
// Pin every response-code branch:
//   - 503 not_configured
//   - 401 unauthorized (missing + wrong bearer, both header names)
//   - 400 bad_json (body isn't JSON)
//   - 400 bad_payload (parser returned structural failure)
//   - 200 noted:"intermediate"  (parser said "ignore")
//   - 200 noted:"unknown_id"    (providerId not in DB)
//   - 200 noted:"no_change"     (state machine rejected transition)
//   - 200 applied:true          (happy path — DB + EventLog written)
//
// The handler talks to Prisma via the `deps` shape, so these tests
// use in-memory fakes. No real DB, no real env, no real fetch. The
// same discipline the dismiss-route tests use.

// ---- Fixtures ----------------------------------------------------

const SECRET = "s3cr3t-webhook-token";
const NOW = new Date("2026-04-20T12:00:00Z");

// Build a deps shape with per-test overrides. Tracks every side
// effect — findInvitation calls, updateInvitation writes, eventLog
// rows — so each test can assert on exactly what was touched.
type SideEffects = {
  // Tracks both providerId AND channel. The handler scopes its DB
  // lookup by (providerId, channel) to prevent a cross-channel ID
  // collision (an SMS messageId landing on a Meta wamid-shaped row,
  // or vice versa) from flipping the wrong invitation's state.
  // Asserting on channel here pins that invariant at the test layer.
  findCalls: Array<{ providerId: string; channel: string }>;
  updates: Array<{
    id: string;
    status: string;
    error: string | null;
    deliveredAt: Date | null;
  }>;
  eventLogs: Array<{
    kind: string;
    refType: string;
    refId: string;
    data: string;
  }>;
};

function mkDeps(opts: {
  secret?: string | undefined;
  invitation?: InvitationRow | null;
  // Per-channel seeding for cross-channel regression tests. When set,
  // findInvitation returns the row matching the looked-up channel (or
  // null if that channel isn't seeded). Takes precedence over
  // `invitation`.
  invitationByChannel?: Partial<Record<string, InvitationRow | null>>;
  effects?: SideEffects;
} = {}): { deps: TaqnyatWebhookDeps; effects: SideEffects } {
  const effects: SideEffects = opts.effects ?? {
    findCalls: [],
    updates: [],
    eventLogs: [],
  };
  const deps: TaqnyatWebhookDeps = {
    getSecret: () => ("secret" in opts ? opts.secret : SECRET),
    findInvitation: async (providerId, channel) => {
      effects.findCalls.push({ providerId, channel });
      if (opts.invitationByChannel) {
        const val = opts.invitationByChannel[channel];
        return val === undefined ? null : val;
      }
      return opts.invitation === undefined ? null : opts.invitation;
    },
    updateInvitation: async (id, data) => {
      effects.updates.push({ id, ...data });
    },
    createEventLog: async (data) => {
      effects.eventLogs.push(data);
    },
    now: () => NOW,
  };
  return { deps, effects };
}

// Build a Request with JSON body + optional auth headers. Used for
// the happy-path cases. URL is cosmetic — the handler only reads
// headers and body.
function req(
  body: unknown,
  opts: {
    auth?: string;
    authHeader?: "authorization" | "x-taqnyat-secret";
    raw?: string;
  } = {},
): Request {
  const headers = new Headers();
  const token = opts.auth ?? SECRET;
  const name = opts.authHeader ?? "authorization";
  if (name === "authorization") headers.set("authorization", `Bearer ${token}`);
  else headers.set("x-taqnyat-secret", token);
  return new Request("https://test.local/api/webhooks/taqnyat/delivery/sms", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

// ---- Auth ---------------------------------------------------------

test("handler: 503 not_configured when TAQNYAT_WEBHOOK_SECRET is unset", async () => {
  // Fail closed. Accepting unauth'd webhooks would let anyone on the
  // internet flip invitation state just by knowing a providerId.
  const { deps, effects } = mkDeps({ secret: undefined });
  const r = await handleTaqnyatDeliveryWebhook(
    req({ messageId: "m", status: "delivered" }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { ok: false, error: "not_configured" });
  // Critically: must NOT have attempted a DB lookup on the
  // unauth'd request.
  assert.equal(effects.findCalls.length, 0);
});

test("handler: 401 unauthorized when no bearer header", async () => {
  const { deps, effects } = mkDeps();
  const raw = new Request("https://test.local/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageId: "m", status: "delivered" }),
  });
  const r = await handleTaqnyatDeliveryWebhook(
    raw,
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { ok: false, error: "unauthorized" });
  assert.equal(effects.findCalls.length, 0);
});

test("handler: 401 unauthorized when bearer value is wrong", async () => {
  const { deps } = mkDeps();
  const r = await handleTaqnyatDeliveryWebhook(
    req({ messageId: "m", status: "delivered" }, { auth: "wrong-token" }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 401);
});

test("handler: accepts `Authorization: Bearer <token>`", async () => {
  // Taqnyat's own send API uses `Authorization: Bearer` — they're
  // more likely to support this header form in webhook configs.
  const { deps, effects } = mkDeps({
    invitation: { id: "inv-1", status: "sent", deliveredAt: null },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req(
      { messageId: "m", status: "delivered" },
      { auth: SECRET, authHeader: "authorization" },
    ),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.equal(effects.updates.length, 1);
});

test("handler: accepts `x-taqnyat-secret` header as fallback", async () => {
  // Some provider webhook UIs can't set Authorization; they can
  // only add custom headers. The fallback keeps integration possible
  // without re-deploying.
  const { deps, effects } = mkDeps({
    invitation: { id: "inv-1", status: "sent", deliveredAt: null },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req(
      { messageId: "m", status: "delivered" },
      { auth: SECRET, authHeader: "x-taqnyat-secret" },
    ),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.equal(effects.updates.length, 1);
});

test("handler: bearer without 'Bearer ' prefix still works (raw token)", async () => {
  // Defensive: if a provider's webhook config doesn't prepend
  // `Bearer `, don't block. The comparison is constant-time either way.
  const { deps, effects } = mkDeps({
    invitation: { id: "inv-1", status: "sent", deliveredAt: null },
  });
  const raw = new Request("https://test.local/", {
    method: "POST",
    headers: {
      authorization: SECRET, // no Bearer prefix
      "content-type": "application/json",
    },
    body: JSON.stringify({ messageId: "m", status: "delivered" }),
  });
  const r = await handleTaqnyatDeliveryWebhook(
    raw,
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.equal(effects.updates.length, 1);
});

// ---- Body parse --------------------------------------------------

test("handler: 400 bad_json when body isn't valid JSON", async () => {
  const { deps, effects } = mkDeps();
  const r = await handleTaqnyatDeliveryWebhook(
    req(undefined, { raw: "not-json{{{" }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { ok: false, error: "bad_json" });
  assert.equal(effects.findCalls.length, 0);
});

test("handler: 400 bad_payload when parser returns bad_provider_id", async () => {
  const { deps } = mkDeps();
  const r = await handleTaqnyatDeliveryWebhook(
    req({ status: "delivered" }), // missing messageId
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, {
    ok: false,
    error: "bad_payload",
    reason: "bad_provider_id",
  });
});

test("handler: 400 bad_payload when parser returns bad_status", async () => {
  const { deps } = mkDeps();
  const r = await handleTaqnyatDeliveryWebhook(
    req({ messageId: "m" }), // missing status
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 400);
  assert.equal((r.body as { reason?: string }).reason, "bad_status");
});

// ---- Intermediate / ignore path ----------------------------------

test("handler: 200 noted:intermediate when parser says ignore (sent)", async () => {
  // Taqnyat will retry anything non-2xx, so intermediate states
  // MUST be acked 200 — otherwise we'd get an infinite retry storm
  // on every "sent" DLR they fire before the terminal one arrives.
  const { deps, effects } = mkDeps();
  const r = await handleTaqnyatDeliveryWebhook(
    req({ messageId: "m", status: "sent" }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "intermediate" });
  // MUST NOT have hit the DB — the payload isn't for us.
  assert.equal(effects.findCalls.length, 0);
  assert.equal(effects.updates.length, 0);
  assert.equal(effects.eventLogs.length, 0);
});

test("handler (WhatsApp): 200 noted:intermediate on `sent` status", async () => {
  const { deps, effects } = mkDeps();
  const r = await handleTaqnyatDeliveryWebhook(
    req({
      entry: [
        { changes: [{ value: { statuses: [{ id: "wamid.X", status: "sent" }] } }] },
      ],
    }),
    parseTaqnyatWhatsAppDlr,
    "whatsapp",
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "intermediate" });
  assert.equal(effects.findCalls.length, 0);
});

test("handler (WhatsApp): 200 noted:intermediate on inbound-message envelope", async () => {
  // Meta's webhook URL can receive both delivery statuses and
  // inbound messages. Inbound is a separate concern; for P12 we
  // ack it 200 so the provider stops retrying and don't touch state.
  const { deps, effects } = mkDeps();
  const r = await handleTaqnyatDeliveryWebhook(
    req({
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
    }),
    parseTaqnyatWhatsAppDlr,
    "whatsapp",
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "intermediate" });
  assert.equal(effects.findCalls.length, 0);
});

// ---- DB-lookup path ----------------------------------------------

test("handler: 200 noted:unknown_id when providerId isn't in DB", async () => {
  // Most common cause: a DLR test fired from Taqnyat's dashboard,
  // or a DLR for a send that predated this deploy. Idempotent 200
  // matches the existing /api/webhooks/delivery contract so
  // providers fire-and-forget.
  const { deps, effects } = mkDeps({ invitation: null });
  const r = await handleTaqnyatDeliveryWebhook(
    req({ messageId: "unknown-msg", status: "delivered" }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "unknown_id" });
  assert.deepEqual(effects.findCalls, [
    { providerId: "unknown-msg", channel: "sms" },
  ]);
  assert.equal(effects.updates.length, 0);
  assert.equal(effects.eventLogs.length, 0);
});

// ---- State-machine outcomes (happy + idempotent) ----------------

test("handler: happy path sent → delivered writes Invitation + EventLog", async () => {
  const { deps, effects } = mkDeps({
    invitation: { id: "inv-1", status: "sent", deliveredAt: null },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req({ messageId: "msg-1", status: "delivered" }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    ok: true,
    applied: true,
    status: "delivered",
  });
  assert.equal(effects.updates.length, 1);
  assert.deepEqual(effects.updates[0], {
    id: "inv-1",
    status: "delivered",
    error: null,
    deliveredAt: NOW,
  });
  assert.equal(effects.eventLogs.length, 1);
  assert.equal(effects.eventLogs[0].kind, "invite.delivered");
  assert.equal(effects.eventLogs[0].refType, "invitation");
  assert.equal(effects.eventLogs[0].refId, "inv-1");
  // The event data blob carries enough context to reconstruct what
  // happened from just the audit log — providerId, status, channel.
  const data = JSON.parse(effects.eventLogs[0].data) as Record<
    string,
    unknown
  >;
  assert.equal(data.providerId, "msg-1");
  assert.equal(data.status, "delivered");
  assert.equal(data.channel, "taqnyat-sms");
});

test("handler: happy path sent → failed writes error string into Invitation.error", async () => {
  const { deps, effects } = mkDeps({
    invitation: { id: "inv-2", status: "sent", deliveredAt: null },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req({
      messageId: "msg-2",
      status: "failed",
      statusDescription: "invalid recipient",
    }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.equal(effects.updates.length, 1);
  assert.equal(effects.updates[0].status, "failed");
  assert.equal(effects.updates[0].error, "invalid recipient");
  assert.equal(effects.updates[0].deliveredAt, null);
  assert.equal(effects.eventLogs[0].kind, "invite.failed");
});

test("handler: idempotent replay (delivered → delivered) is a no-op 200", async () => {
  // Taqnyat retries on non-2xx. A 200 that didn't write doubled
  // rows in EventLog would be an ops nightmare; the state machine
  // guards this and the handler must honor it with noted:no_change.
  const deliveredAt = new Date("2026-04-20T11:30:00Z");
  const { deps, effects } = mkDeps({
    invitation: { id: "inv-3", status: "delivered", deliveredAt },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req({ messageId: "msg-3", status: "delivered" }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "no_change" });
  assert.equal(effects.updates.length, 0);
  assert.equal(effects.eventLogs.length, 0);
});

test("handler: regression blocked (delivered → failed) is a no-op 200", async () => {
  // A late DLR for a pre-delivery retry whose original got delivered
  // anyway. Must NOT overwrite the terminal success.
  const deliveredAt = new Date("2026-04-20T11:30:00Z");
  const { deps, effects } = mkDeps({
    invitation: { id: "inv-4", status: "delivered", deliveredAt },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req({
      messageId: "msg-4",
      status: "failed",
      statusDescription: "late timeout",
    }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "no_change" });
  assert.equal(effects.updates.length, 0);
});

test("handler: idempotent replay of `failed` is a no-op 200", async () => {
  const { deps, effects } = mkDeps({
    invitation: { id: "inv-5", status: "failed", deliveredAt: null },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req({ messageId: "msg-5", status: "failed" }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "no_change" });
  assert.equal(effects.updates.length, 0);
});

test("handler (WhatsApp): Meta envelope delivered → DB + EventLog written with taqnyat-whatsapp channel tag", async () => {
  const { deps, effects } = mkDeps({
    invitation: { id: "inv-w", status: "sent", deliveredAt: null },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: "wamid.XYZ", status: "delivered" }],
              },
            },
          ],
        },
      ],
    }),
    parseTaqnyatWhatsAppDlr,
    "whatsapp",
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    ok: true,
    applied: true,
    status: "delivered",
  });
  assert.deepEqual(effects.findCalls, [
    { providerId: "wamid.XYZ", channel: "whatsapp" },
  ]);
  assert.equal(effects.updates[0].status, "delivered");
  const logData = JSON.parse(effects.eventLogs[0].data) as {
    channel: string;
  };
  // The `channel` tag distinguishes SMS vs WhatsApp in the audit
  // trail. A future query like "how many WhatsApp delivery failures
  // this week" keys off this field.
  assert.equal(logData.channel, "taqnyat-whatsapp");
});

test("handler (WhatsApp): failed with Meta nested errors surfaces full error string in EventLog", async () => {
  const { deps, effects } = mkDeps({
    invitation: { id: "inv-wf", status: "sent", deliveredAt: null },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  {
                    id: "wamid.F",
                    status: "failed",
                    errors: [
                      {
                        code: 131047,
                        title: "Re-engagement",
                        message: "session closed",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
    parseTaqnyatWhatsAppDlr,
    "whatsapp",
    deps,
  );
  assert.equal(r.status, 200);
  assert.equal(effects.updates[0].status, "failed");
  const err = effects.updates[0].error ?? "";
  // All three parts of Meta's error envelope must land in the
  // invitation.error column so ops don't have to cross-reference
  // provider dashboards to diagnose.
  assert.match(err, /code=131047/);
  assert.match(err, /Re-engagement/);
  assert.match(err, /session closed/);
});

// ---- Recovery path (non-regressive) ------------------------------

test("handler: failed → delivered IS allowed (carrier-retry recovery)", async () => {
  // Rare but real: carrier did an internal retry under Taqnyat's
  // layer and the message actually got through after we'd marked
  // it failed. Accept the recovery — delivered is the truth.
  const { deps, effects } = mkDeps({
    invitation: { id: "inv-r", status: "failed", deliveredAt: null },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req({ messageId: "msg-r", status: "delivered" }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.equal(effects.updates[0].status, "delivered");
  assert.deepEqual(effects.updates[0].deliveredAt, NOW);
  assert.equal(effects.eventLogs[0].kind, "invite.delivered");
});

// ---- Cross-channel collision (P12-fix regression) ----------------
//
// Invitation.providerId is indexed but NOT unique (prisma/schema.prisma
// line ~195). Nothing at the DB level prevents an SMS messageId and a
// Meta wamid from colliding — they're drawn from different issuers'
// random namespaces and over a large campaign corpus will eventually
// overlap. An even more likely failure: the operator misconfigures
// Taqnyat's two webhook URLs and a WhatsApp DLR lands on the SMS
// endpoint (or vice versa). Without channel scoping, the lookup would
// find a row from the OTHER channel, flip its state, and write an
// EventLog carrying the wrong channel tag.
//
// These tests pin the invariant: each route filters by channel and
// therefore can never touch rows that don't belong to it.

test("handler (SMS): WhatsApp-only invitation with same providerId returns unknown_id", async () => {
  // Seed ONLY a WhatsApp-channel invitation at this providerId. The
  // SMS route's lookup must be scoped such that it does not find it.
  const { deps, effects } = mkDeps({
    invitationByChannel: {
      whatsapp: { id: "inv-wa-collide", status: "sent", deliveredAt: null },
    },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req({ messageId: "shared-id", status: "delivered" }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "unknown_id" });
  // Critical invariants: the lookup was attempted WITH channel="sms",
  // and no writes happened against the WhatsApp row.
  assert.deepEqual(effects.findCalls, [
    { providerId: "shared-id", channel: "sms" },
  ]);
  assert.equal(effects.updates.length, 0);
  assert.equal(effects.eventLogs.length, 0);
});

test("handler (WhatsApp): SMS-only invitation with same providerId returns unknown_id", async () => {
  // Mirror of the above: a DLR that somehow arrives at the WhatsApp
  // route (wrong-URL config, or an actual namespace collision) must
  // not update an SMS-channel row.
  const { deps, effects } = mkDeps({
    invitationByChannel: {
      sms: { id: "inv-sms-collide", status: "sent", deliveredAt: null },
    },
  });
  const r = await handleTaqnyatDeliveryWebhook(
    req({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: "shared-id", status: "delivered" }],
              },
            },
          ],
        },
      ],
    }),
    parseTaqnyatWhatsAppDlr,
    "whatsapp",
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "unknown_id" });
  assert.deepEqual(effects.findCalls, [
    { providerId: "shared-id", channel: "whatsapp" },
  ]);
  assert.equal(effects.updates.length, 0);
  assert.equal(effects.eventLogs.length, 0);
});

test("handler: when both channels share a providerId, each route updates only its own row", async () => {
  // The strongest form of the invariant: TWO rows exist with the
  // same providerId, one per channel. Each route call must find
  // exactly the one matching its channel and leave the other
  // untouched. This is what GPT's blocker asked for verbatim.
  const smsRow: InvitationRow = {
    id: "inv-sms-pair",
    status: "sent",
    deliveredAt: null,
  };
  const waRow: InvitationRow = {
    id: "inv-wa-pair",
    status: "sent",
    deliveredAt: null,
  };
  const { deps, effects } = mkDeps({
    invitationByChannel: { sms: smsRow, whatsapp: waRow },
  });

  // Fire the SMS route first. Must land on smsRow only.
  const rSms = await handleTaqnyatDeliveryWebhook(
    req({ messageId: "pair-id", status: "delivered" }),
    parseTaqnyatSmsDlr,
    "sms",
    deps,
  );
  assert.equal(rSms.status, 200);
  assert.deepEqual(rSms.body, {
    ok: true,
    applied: true,
    status: "delivered",
  });
  assert.equal(effects.updates.length, 1);
  assert.equal(effects.updates[0].id, "inv-sms-pair");
  assert.equal(effects.eventLogs.length, 1);
  const smsLog = JSON.parse(effects.eventLogs[0].data) as { channel: string };
  assert.equal(smsLog.channel, "taqnyat-sms");

  // Now fire the WhatsApp route with the SAME providerId. Must land
  // on waRow only — smsRow remains at exactly one update from above.
  const rWa = await handleTaqnyatDeliveryWebhook(
    req({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: "pair-id", status: "delivered" }],
              },
            },
          ],
        },
      ],
    }),
    parseTaqnyatWhatsAppDlr,
    "whatsapp",
    deps,
  );
  assert.equal(rWa.status, 200);
  assert.deepEqual(rWa.body, {
    ok: true,
    applied: true,
    status: "delivered",
  });
  assert.equal(effects.updates.length, 2);
  assert.equal(effects.updates[1].id, "inv-wa-pair");
  assert.equal(effects.eventLogs.length, 2);
  const waLog = JSON.parse(effects.eventLogs[1].data) as { channel: string };
  assert.equal(waLog.channel, "taqnyat-whatsapp");

  // Both lookups happened, each with its own channel. This is the
  // line that would have failed prior to the fix — without channel
  // scoping, the SMS route would have randomly found EITHER row
  // based on DB ordering, not the SMS one specifically.
  assert.deepEqual(effects.findCalls, [
    { providerId: "pair-id", channel: "sms" },
    { providerId: "pair-id", channel: "whatsapp" },
  ]);
});
