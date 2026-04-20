// P12 — Taqnyat delivery webhook parsers + state-transition helper.
//
// Pure module. No Prisma, no Next.js, no process.env. Every side
// effect lives in the route handler that calls these helpers. Tests
// drive the parsers and the state machine directly, without an HTTP
// harness.
//
// Two shapes we have to accept:
//
//   1. Taqnyat SMS DLR (delivery receipt) — posted to the app when
//      Taqnyat's SMS backend learns the terminal fate of a send.
//      Shape mirrors the send-response convention: a JSON object
//      with an identifier and a status string. Field names drift
//      across provider generations (`messageId` | `id` | `requestId`)
//      so we tolerate the common variants. Status value vocabulary
//      is normalized to the three states Invitation.status supports:
//      `delivered | failed | bounced`.
//
//   2. Taqnyat WhatsApp DLR — Taqnyat wraps Meta's Cloud API webhook
//      envelope:
//        { entry: [{ changes: [{ value: { statuses: [
//          { id: "wamid...", status: "delivered" | ..., errors?: [...] }
//        ] } }] }] }
//      We walk the envelope, pick the first status entry (Meta
//      typically sends one per webhook), and map.
//
// Scope: DELIVERY only. Inbound replies are a separate route (not in
// P12). Intermediate states like `sent`, `accepted`, `queued`, `read`
// are ignored — our three-state Invitation model doesn't model them,
// and the send path already writes `sent` on the 2xx send response.

export type TaqnyatDlrParse =
  | { ok: true; providerId: string; status: NormalizedStatus; error: string | null }
  | { ok: false; reason: "bad_json" | "bad_provider_id" | "bad_status" | "ignore" };

// The three Invitation statuses a webhook may transition to. Matches
// the ALLOWED_STATUS set in the existing /api/webhooks/delivery route.
export type NormalizedStatus = "delivered" | "failed" | "bounced";

// ---------------------------------------------------------------- SMS

// Reasonable SMS status vocabulary across Taqnyat + upstream carriers.
// We normalize to our three-state model:
//   - delivered: terminal success
//   - failed: terminal non-permanent (could be retried; we don't retry
//             automatically, but the distinction from bounced matters
//             for ops metrics)
//   - bounced: terminal permanent (unknown number, blocked, expired
//              after TTL); re-sending wouldn't help
//
// Unknown vocabulary collapses to `failed` rather than `bounced` —
// "failed" is the more recoverable classification, so if the provider
// invents a new status string we surface it as a soft failure rather
// than marking the invitee unreachable.
const SMS_STATUS_MAP: Record<string, NormalizedStatus> = {
  delivered: "delivered",
  success: "delivered",

  failed: "failed",
  error: "failed",
  rejected: "failed",

  expired: "bounced",
  undelivered: "bounced",
  unknown: "bounced",
};

// Taqnyat's SMS DLR body is a flat JSON object. Example shapes we
// tolerate:
//   { "messageId": "12345", "status": "DELIVERED", "statusDescription": "ok" }
//   { "id": "12345",         "status": "failed",   "error": "invalid recipient" }
//   { "requestId": "12345",  "status": "expired" }
export function parseTaqnyatSmsDlr(body: unknown): TaqnyatDlrParse {
  if (!isPlainObject(body)) return { ok: false, reason: "bad_json" };
  const providerId = firstNonEmptyString(body, [
    "messageId",
    "id",
    "requestId",
  ]);
  if (!providerId) return { ok: false, reason: "bad_provider_id" };

  const rawStatus = firstNonEmptyString(body, ["status", "state"]);
  if (!rawStatus) return { ok: false, reason: "bad_status" };

  const normalized = SMS_STATUS_MAP[rawStatus.toLowerCase()];
  if (!normalized) {
    // Intermediate states (`sent`, `accepted`, `queued`) are ignored
    // rather than treated as a parse failure — Taqnyat can legitimately
    // fire multiple callbacks per send, and we shouldn't 400 the ones
    // we don't care about. Caller returns 200 OK on `ignore`.
    if (isIntermediateSmsStatus(rawStatus)) return { ok: false, reason: "ignore" };
    // A status string outside BOTH the terminal and intermediate
    // vocabularies — treat as a soft failure. See the UNKNOWN →
    // "failed" comment above. This path is the catch-all; we don't
    // use "ignore" here because an unrecognized value may be a signal
    // the provider pushed a breaking change and we want it visible in
    // the Invitation + EventLog, not silently dropped.
    return {
      ok: true,
      providerId,
      status: "failed",
      error: `taqnyat: unrecognized status "${rawStatus.slice(0, 64)}"`,
    };
  }

  const errorText = firstNonEmptyString(body, [
    "statusDescription",
    "error",
    "message",
    "reason",
  ]);
  return {
    ok: true,
    providerId,
    status: normalized,
    error: errorText ? errorText.slice(0, 500) : null,
  };
}

function isIntermediateSmsStatus(raw: string): boolean {
  const s = raw.toLowerCase();
  return (
    s === "sent" ||
    s === "accepted" ||
    s === "queued" ||
    s === "pending" ||
    s === "processing"
  );
}

// ----------------------------------------------------------- WhatsApp

// Meta's WhatsApp Cloud API status vocabulary:
//   - sent:      message left our infra for Meta's infra (ignore)
//   - delivered: device acked receipt (TERMINAL)
//   - read:      user opened the message (ignore; outside our model)
//   - failed:    permanent failure with nested `errors[0]` (TERMINAL)
//
// Taqnyat proxies these unchanged in the `statuses` array.
const WA_STATUS_MAP: Record<string, NormalizedStatus> = {
  delivered: "delivered",
  failed: "failed",
};

// Taqnyat WhatsApp DLR is Meta's envelope wrapped by Taqnyat.
// We walk to value.statuses[0]. If the webhook contains an inbound
// message instead (value.messages[...]), we ignore — inbound is a
// separate route.
export function parseTaqnyatWhatsAppDlr(body: unknown): TaqnyatDlrParse {
  if (!isPlainObject(body)) return { ok: false, reason: "bad_json" };
  const entries = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, reason: "bad_json" };
  }
  const firstEntry = entries[0];
  if (!isPlainObject(firstEntry)) return { ok: false, reason: "bad_json" };
  const changes = (firstEntry as { changes?: unknown }).changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    return { ok: false, reason: "bad_json" };
  }
  const firstChange = changes[0];
  if (!isPlainObject(firstChange)) return { ok: false, reason: "bad_json" };
  const value = (firstChange as { value?: unknown }).value;
  if (!isPlainObject(value)) return { ok: false, reason: "bad_json" };

  const statuses = (value as { statuses?: unknown }).statuses;
  // An inbound-message webhook (no `statuses`, has `messages`) is a
  // different event class — return "ignore" so the route replies 200
  // without touching state. The inbound-reply route can be wired in a
  // later phase if product wants replies in the workspace.
  if (!Array.isArray(statuses) || statuses.length === 0) {
    const messages = (value as { messages?: unknown }).messages;
    if (Array.isArray(messages)) return { ok: false, reason: "ignore" };
    return { ok: false, reason: "bad_json" };
  }

  const firstStatus = statuses[0];
  if (!isPlainObject(firstStatus)) return { ok: false, reason: "bad_json" };
  const providerId = firstNonEmptyString(firstStatus, ["id"]);
  if (!providerId) return { ok: false, reason: "bad_provider_id" };

  const rawStatus = firstNonEmptyString(firstStatus, ["status"]);
  if (!rawStatus) return { ok: false, reason: "bad_status" };

  const normalized = WA_STATUS_MAP[rawStatus.toLowerCase()];
  if (!normalized) {
    // Meta's `sent` / `read` states are normal intermediates — ignore.
    if (rawStatus.toLowerCase() === "sent" || rawStatus.toLowerCase() === "read") {
      return { ok: false, reason: "ignore" };
    }
    // Unknown vocabulary — same soft-fail path as SMS.
    return {
      ok: true,
      providerId,
      status: "failed",
      error: `taqnyat-whatsapp: unrecognized status "${rawStatus.slice(0, 64)}"`,
    };
  }

  // Meta nests failure detail under `errors: [{code, title, message?}]`.
  let errorText: string | null = null;
  if (normalized === "failed") {
    const errors = (firstStatus as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0 && isPlainObject(errors[0])) {
      const e = errors[0] as Record<string, unknown>;
      const parts = [
        typeof e.code === "number" || typeof e.code === "string"
          ? `code=${e.code}`
          : null,
        typeof e.title === "string" ? e.title : null,
        typeof e.message === "string" ? e.message : null,
      ].filter((s): s is string => !!s);
      errorText = parts.length > 0 ? parts.join(" — ").slice(0, 500) : null;
    }
  }
  return { ok: true, providerId, status: normalized, error: errorText };
}

// ------------------------------------------------------ state machine

export type DeliveryTransition = {
  // True iff the Invitation row should be written. False for idempotent
  // replays and for regressions from a terminal success.
  shouldUpdate: boolean;
  nextStatus?: NormalizedStatus;
  nextError?: string | null;
  nextDeliveredAt?: Date | null;
};

// The one hard rule: once an Invitation has been marked `delivered`,
// a later webhook cannot regress it back to `failed` / `bounced` /
// `sent`. The typical cause would be a delayed DLR from a pre-delivery
// retry attempt whose original message was eventually delivered by
// the carrier. Without this guard, the Invitation audit trail would
// flip-flop.
//
// Idempotency: a second `delivered` webhook for an already-delivered
// row is a no-op — same status, same deliveredAt kept, no EventLog
// row written. The existing /api/webhooks/delivery route didn't guard
// this; replays produced duplicate `invite.delivered` EventLog rows
// and nudged `deliveredAt` forward on each ping. P12 fixes that here.
export function decideDeliveryTransition(
  current: { status: string; deliveredAt: Date | null },
  incoming: { status: NormalizedStatus; error: string | null },
  now: Date,
): DeliveryTransition {
  // Regression guard — terminal delivered is sticky.
  if (current.status === "delivered") {
    return { shouldUpdate: false };
  }

  // Idempotent replay of the same non-delivered terminal state —
  // don't write again, don't re-audit.
  if (current.status === incoming.status) {
    return { shouldUpdate: false };
  }

  return {
    shouldUpdate: true,
    nextStatus: incoming.status,
    nextError: incoming.error,
    // deliveredAt only advances when we're transitioning INTO the
    // delivered state. Transitions into failed/bounced leave the
    // prior deliveredAt (almost certainly null) untouched.
    nextDeliveredAt: incoming.status === "delivered" ? now : current.deliveredAt,
  };
}

// ------------------------------------------------------------ helpers

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstNonEmptyString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}
