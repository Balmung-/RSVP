import { createHmac, timingSafeEqual } from "node:crypto";
import {
  decideDeliveryTransition,
  type NormalizedStatus,
} from "@/lib/providers/taqnyat/webhooks";

// Generic delivery-status webhook handler. Pure — no Prisma import,
// no env read, no clock read. The route wrapper in `route.ts` injects
// the real deps; unit tests inject stubs.
//
// Addresses findings 2 & 3 of the 2026-04-21 deep audit:
//   - Finding 2: the previous implementation did
//     `findFirst({ where: { providerId } })` with no channel scope.
//     `Invitation.providerId` is indexed but NOT unique, and while
//     a cross-channel providerId collision is unlikely in practice
//     (Taqnyat's IDs don't collide with Resend's / SendGrid's ID
//     spaces), nothing at the DB level prevents it. A misrouted
//     webhook (e.g. an operator-configured email relay pointed at
//     a payload claiming a providerId that happens to match an SMS
//     invitation's id) would mutate the wrong row. Channel scoping
//     closes that class.
//   - Finding 3: the previous implementation blindly wrote `status`
//     from the incoming payload and logged an `invite.<status>` row
//     unconditionally. A late `failed` after `delivered` would
//     regress the row; a duplicate `delivered` would duplicate the
//     EventLog entry. The Taqnyat channel-scoped handler already
//     uses `decideDeliveryTransition` to make `delivered` sticky
//     and same-status replays no-ops; we reuse that helper here.
//
// Response vocabulary matches the Taqnyat handler for consistency:
//   - 503 not_configured      — WEBHOOK_SIGNING_SECRET unset
//   - 401 bad_signature       — HMAC mismatch
//   - 400 bad_json            — body wasn't valid JSON
//   - 400 bad_payload         — missing/unsupported providerId /
//                               status / channel. Includes `reason`.
//   - 200 noted:"unknown_id"  — providerId not found for this
//                               channel. Idempotent ack so providers
//                               stop retrying.
//   - 200 noted:"no_change"   — state machine said no (idempotent
//                               replay or post-delivered regression).
//   - 200 applied:true        — wrote Invitation + EventLog.
//
// Allowed channels ("email" | "sms" | "whatsapp") match the values
// the send path writes to Invitation.channel. The payload must
// include the channel because the generic route sits in front of
// multiple providers and is not itself channel-scoped by path
// (unlike the Taqnyat sms/whatsapp subroutes).

const ALLOWED_STATUS = new Set<NormalizedStatus>([
  "delivered",
  "failed",
  "bounced",
]);

const ALLOWED_CHANNELS = new Set(["email", "sms", "whatsapp"]);

export type InvitationRow = {
  id: string;
  status: string;
  deliveredAt: Date | null;
};

export interface GenericDeliveryWebhookDeps {
  getSecret: () => string | undefined;
  findInvitation: (
    providerId: string,
    channel: string,
  ) => Promise<InvitationRow | null>;
  updateInvitation: (
    id: string,
    data: {
      status: string;
      error: string | null;
      deliveredAt: Date | null;
    },
  ) => Promise<void>;
  createEventLog: (data: {
    kind: string;
    refType: string;
    refId: string;
    data: string;
  }) => Promise<void>;
  now: () => Date;
}

export type GenericDeliveryResult = {
  status: number;
  body: Record<string, unknown>;
};

export async function handleGenericDeliveryWebhook(
  req: Request,
  deps: GenericDeliveryWebhookDeps,
): Promise<GenericDeliveryResult> {
  const secret = deps.getSecret();
  const raw = await req.text();

  if (!secret) {
    return {
      status: 503,
      body: { ok: false, error: "not_configured" },
    };
  }

  const sig = req.headers.get("x-signature") ?? "";
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { status: 401, body: { ok: false, error: "bad_signature" } };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, body: { ok: false, error: "bad_json" } };
  }

  // Structural parse. All four of providerId, status, channel are
  // required; error is optional. `reason` field on failure mirrors
  // the Taqnyat handler so access logs can debug without reading
  // the body back.
  const isObject =
    typeof body === "object" && body !== null && !Array.isArray(body);
  if (!isObject) {
    return {
      status: 400,
      body: { ok: false, error: "bad_payload", reason: "not_object" },
    };
  }
  const obj = body as Record<string, unknown>;
  const providerId = typeof obj.providerId === "string" ? obj.providerId : "";
  const statusRaw = typeof obj.status === "string" ? obj.status : "";
  const channel = typeof obj.channel === "string" ? obj.channel : "";
  const error =
    typeof obj.error === "string" ? obj.error.slice(0, 500) : null;

  if (!providerId) {
    return {
      status: 400,
      body: { ok: false, error: "bad_payload", reason: "missing_provider_id" },
    };
  }
  if (!ALLOWED_CHANNELS.has(channel)) {
    return {
      status: 400,
      body: { ok: false, error: "bad_payload", reason: "bad_channel" },
    };
  }
  if (!ALLOWED_STATUS.has(statusRaw as NormalizedStatus)) {
    return {
      status: 400,
      body: { ok: false, error: "bad_payload", reason: "bad_status" },
    };
  }
  const status = statusRaw as NormalizedStatus;

  const inv = await deps.findInvitation(providerId, channel);
  if (!inv) {
    // Unknown providerId FOR THIS CHANNEL. Matches the legacy
    // contract's idempotent 200 so providers fire-and-forget.
    return { status: 200, body: { ok: true, noted: "unknown_id" } };
  }

  const transition = decideDeliveryTransition(
    { status: inv.status, deliveredAt: inv.deliveredAt },
    { status, error },
    deps.now(),
  );
  if (!transition.shouldUpdate) {
    return { status: 200, body: { ok: true, noted: "no_change" } };
  }

  await deps.updateInvitation(inv.id, {
    status: transition.nextStatus!,
    error: transition.nextError ?? null,
    deliveredAt: transition.nextDeliveredAt ?? null,
  });
  await deps.createEventLog({
    kind: `invite.${transition.nextStatus}`,
    refType: "invitation",
    refId: inv.id,
    data: JSON.stringify({
      providerId,
      status: transition.nextStatus,
      error: transition.nextError ?? null,
      channel,
    }),
  });
  return {
    status: 200,
    body: { ok: true, applied: true, status: transition.nextStatus },
  };
}
