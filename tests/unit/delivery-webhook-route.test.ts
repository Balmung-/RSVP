import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  handleGenericDeliveryWebhook,
  type InvitationRow,
  type GenericDeliveryWebhookDeps,
} from "../../src/app/api/webhooks/delivery/handler";

// P17-A.AUDIT-2+3 — route-level tests for the generic delivery
// webhook handler.
//
// Pre-AUDIT this route was untested AND had two real correctness
// bugs: (a) `findFirst(providerId)` with no channel scope, (b)
// blind status writes + duplicate EventLogs (no monotonic state
// machine, no idempotent replay). The refactor brings it up to
// parity with the Taqnyat handler; these tests pin every branch so
// a regression can't silently reopen the class.
//
// Response-code branches pinned:
//   - 503 not_configured           (WEBHOOK_SIGNING_SECRET unset)
//   - 401 bad_signature            (HMAC mismatch + empty sig)
//   - 400 bad_json                 (body isn't JSON)
//   - 400 bad_payload / not_object (body is JSON but a primitive/array)
//   - 400 bad_payload / missing_provider_id
//   - 400 bad_payload / bad_channel
//   - 400 bad_payload / bad_status
//   - 200 noted:"unknown_id"       (providerId not found for channel)
//   - 200 noted:"no_change"        (state machine rejected)
//   - 200 applied:true             (happy path — DB + EventLog written)
//
// Plus two extra pins that specifically encode the audit findings:
//   - Finding 2: findInvitation is called with (providerId, channel)
//     and a cross-channel ID collision routes to the right row.
//   - Finding 3: sticky-delivered regression is a no_change, not a
//     status rewrite; idempotent replay writes no EventLog.

const SECRET = "deadbeefcafebabe";
const NOW = new Date("2026-04-21T12:00:00Z");

type SideEffects = {
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
  invitationByChannel?: Partial<Record<string, InvitationRow | null>>;
  effects?: SideEffects;
} = {}): { deps: GenericDeliveryWebhookDeps; effects: SideEffects } {
  const effects: SideEffects = opts.effects ?? {
    findCalls: [],
    updates: [],
    eventLogs: [],
  };
  const deps: GenericDeliveryWebhookDeps = {
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

// Sign a raw body the same way a real shim would — hex HMAC-SHA256
// of the raw bytes under SECRET. Returns a Request with that
// signature in x-signature.
function req(
  body: unknown,
  opts: { signingSecret?: string; sig?: string; raw?: string } = {},
): Request {
  const raw = opts.raw ?? JSON.stringify(body);
  const sig =
    opts.sig !== undefined
      ? opts.sig
      : createHmac("sha256", opts.signingSecret ?? SECRET).update(raw).digest("hex");
  const headers = new Headers();
  headers.set("x-signature", sig);
  return new Request("https://test.local/api/webhooks/delivery", {
    method: "POST",
    headers,
    body: raw,
  });
}

// ---- Auth / parse --------------------------------------------------

test("handler: 503 not_configured when WEBHOOK_SIGNING_SECRET is unset", async () => {
  const { deps, effects } = mkDeps({ secret: undefined });
  const r = await handleGenericDeliveryWebhook(
    req({ providerId: "p1", channel: "sms", status: "delivered" }),
    deps,
  );
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { ok: false, error: "not_configured" });
  assert.equal(effects.findCalls.length, 0, "no DB touch when unconfigured");
});

test("handler: 401 bad_signature when x-signature is wrong", async () => {
  const { deps, effects } = mkDeps();
  const r = await handleGenericDeliveryWebhook(
    req({ providerId: "p1", channel: "sms", status: "delivered" }, { sig: "00" }),
    deps,
  );
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { ok: false, error: "bad_signature" });
  assert.equal(effects.findCalls.length, 0);
});

test("handler: 401 bad_signature when x-signature header is absent", async () => {
  const { deps } = mkDeps();
  const body = { providerId: "p1", channel: "sms", status: "delivered" };
  // Constructed without the signature header on purpose — bare
  // Request so we can skip the signing helper.
  const r = await handleGenericDeliveryWebhook(
    new Request("https://test.local/api/webhooks/delivery", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    mkDeps().deps,
  );
  assert.equal(r.status, 401);
  // Suppress unused warning via a no-op assert on deps.
  assert.ok(deps);
});

test("handler: 400 bad_json when the body isn't JSON", async () => {
  const { deps, effects } = mkDeps();
  const raw = "not-json-at-all";
  const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
  const r = await handleGenericDeliveryWebhook(
    new Request("https://test.local/api/webhooks/delivery", {
      method: "POST",
      headers: { "x-signature": sig },
      body: raw,
    }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { ok: false, error: "bad_json" });
  assert.equal(effects.findCalls.length, 0);
});

test("handler: 400 bad_payload/not_object when body is a JSON primitive", async () => {
  const { deps } = mkDeps();
  const r = await handleGenericDeliveryWebhook(req("just-a-string"), deps);
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, {
    ok: false,
    error: "bad_payload",
    reason: "not_object",
  });
});

test("handler: 400 bad_payload/missing_provider_id", async () => {
  const { deps } = mkDeps();
  const r = await handleGenericDeliveryWebhook(
    req({ channel: "sms", status: "delivered" }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, {
    ok: false,
    error: "bad_payload",
    reason: "missing_provider_id",
  });
});

test("handler: 400 bad_payload/bad_channel when channel is absent", async () => {
  const { deps } = mkDeps();
  const r = await handleGenericDeliveryWebhook(
    req({ providerId: "p1", status: "delivered" }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, {
    ok: false,
    error: "bad_payload",
    reason: "bad_channel",
  });
});

test("handler: 400 bad_payload/bad_channel when channel is an unknown value", async () => {
  const { deps } = mkDeps();
  const r = await handleGenericDeliveryWebhook(
    req({ providerId: "p1", channel: "fax", status: "delivered" }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, {
    ok: false,
    error: "bad_payload",
    reason: "bad_channel",
  });
});

test("handler: 400 bad_payload/bad_status for unsupported status", async () => {
  const { deps } = mkDeps();
  const r = await handleGenericDeliveryWebhook(
    req({ providerId: "p1", channel: "sms", status: "queued" }),
    deps,
  );
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, {
    ok: false,
    error: "bad_payload",
    reason: "bad_status",
  });
});

// ---- Happy paths --------------------------------------------------

test("handler: 200 noted:unknown_id when providerId not found for channel", async () => {
  const { deps, effects } = mkDeps({ invitation: null });
  const r = await handleGenericDeliveryWebhook(
    req({ providerId: "ghost", channel: "sms", status: "delivered" }),
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "unknown_id" });
  assert.equal(effects.findCalls.length, 1);
  assert.deepEqual(effects.findCalls[0], { providerId: "ghost", channel: "sms" });
  assert.equal(effects.updates.length, 0);
  assert.equal(effects.eventLogs.length, 0);
});

test("handler: 200 applied:true writes Invitation + EventLog on happy-path delivered", async () => {
  const inv: InvitationRow = { id: "inv-1", status: "sent", deliveredAt: null };
  const { deps, effects } = mkDeps({ invitation: inv });
  const r = await handleGenericDeliveryWebhook(
    req({ providerId: "p1", channel: "email", status: "delivered" }),
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, applied: true, status: "delivered" });
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
  const parsed = JSON.parse(effects.eventLogs[0].data) as Record<string, unknown>;
  assert.equal(parsed.channel, "email");
  assert.equal(parsed.providerId, "p1");
  assert.equal(parsed.status, "delivered");
});

test("handler: 200 applied:true carries error through on failed status", async () => {
  const inv: InvitationRow = { id: "inv-1", status: "sent", deliveredAt: null };
  const { deps, effects } = mkDeps({ invitation: inv });
  const r = await handleGenericDeliveryWebhook(
    req({
      providerId: "p1",
      channel: "sms",
      status: "failed",
      error: "carrier declined",
    }),
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(effects.updates[0], {
    id: "inv-1",
    status: "failed",
    error: "carrier declined",
    deliveredAt: null,
  });
});

// ---- Audit Finding 2: channel scoping invariant ------------------

test("handler: Finding 2 — cross-channel ID collision routes to the correct row", async () => {
  // Two invitations with the SAME providerId across different
  // channels — the exact bug class GPT's deep audit caught. The
  // handler must scope by channel; a `sms` payload must not mutate
  // the email row or vice versa.
  const emailRow: InvitationRow = {
    id: "inv-email",
    status: "sent",
    deliveredAt: null,
  };
  const smsRow: InvitationRow = {
    id: "inv-sms",
    status: "sent",
    deliveredAt: null,
  };
  const { deps, effects } = mkDeps({
    invitationByChannel: { email: emailRow, sms: smsRow },
  });
  // Send a payload claiming channel=sms → handler must look up
  // (providerId=shared-id, channel=sms) and find the SMS row.
  const r = await handleGenericDeliveryWebhook(
    req({ providerId: "shared-id", channel: "sms", status: "delivered" }),
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, applied: true, status: "delivered" });
  assert.equal(effects.findCalls.length, 1);
  assert.deepEqual(effects.findCalls[0], {
    providerId: "shared-id",
    channel: "sms",
  });
  // And we updated the SMS row, NOT the email row.
  assert.equal(effects.updates.length, 1);
  assert.equal(effects.updates[0].id, "inv-sms");
});

// ---- Audit Finding 3: monotonic + idempotent -----------------------

test("handler: Finding 3 — already-delivered row is sticky against a later failed webhook", async () => {
  const inv: InvitationRow = {
    id: "inv-1",
    status: "delivered",
    deliveredAt: new Date("2026-04-20T10:00:00Z"),
  };
  const { deps, effects } = mkDeps({ invitation: inv });
  const r = await handleGenericDeliveryWebhook(
    req({
      providerId: "p1",
      channel: "sms",
      status: "failed",
      error: "late carrier NACK",
    }),
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "no_change" });
  assert.equal(effects.updates.length, 0, "no status regression");
  assert.equal(
    effects.eventLogs.length,
    0,
    "no EventLog row for a no-op transition",
  );
});

test("handler: Finding 3 — duplicate delivered webhook is a no_change no-op", async () => {
  const inv: InvitationRow = {
    id: "inv-1",
    status: "delivered",
    deliveredAt: new Date("2026-04-20T10:00:00Z"),
  };
  const { deps, effects } = mkDeps({ invitation: inv });
  const r = await handleGenericDeliveryWebhook(
    req({ providerId: "p1", channel: "sms", status: "delivered" }),
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "no_change" });
  assert.equal(effects.updates.length, 0);
  assert.equal(effects.eventLogs.length, 0, "no duplicate invite.delivered");
});

test("handler: Finding 3 — duplicate failed webhook is a no_change no-op", async () => {
  const inv: InvitationRow = {
    id: "inv-1",
    status: "failed",
    deliveredAt: null,
  };
  const { deps, effects } = mkDeps({ invitation: inv });
  const r = await handleGenericDeliveryWebhook(
    req({
      providerId: "p1",
      channel: "sms",
      status: "failed",
      error: "same reason",
    }),
    deps,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, noted: "no_change" });
  assert.equal(effects.updates.length, 0);
  assert.equal(effects.eventLogs.length, 0);
});
