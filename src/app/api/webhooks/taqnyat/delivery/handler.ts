import { secretMatches } from "@/lib/webhook-auth";
import {
  decideDeliveryTransition,
  type TaqnyatDlrParse,
} from "@/lib/providers/taqnyat/webhooks";

// P12 — shared pure handler for Taqnyat delivery receipt webhooks.
//
// The two route wrappers (sms/route.ts, whatsapp/route.ts) differ
// ONLY in which parser they pass in. Everything else — auth gate,
// body read + JSON parse, state-transition decision, DB writes,
// response shape — is identical. Living in the handler means:
//
//   - Tests exercise both channels through one harness with plain
//     in-memory deps. The real Prisma + env + fetch never run.
//   - The response contract is pinned in one place; a future
//     refactor that changes "unknown_id" to something else updates
//     both channels together.
//   - The auth/idempotency/regression discipline can't drift between
//     channels.
//
// The handler is DELIBERATELY not a Next.js route. `route.ts` owns
// the Next boundary (reads process.env, imports Prisma, returns
// NextResponse). This file is plain data-in / data-out.
//
// Response vocabulary:
//   - 503 not_configured     — TAQNYAT_WEBHOOK_SECRET missing. Fail
//                              closed rather than silently accept
//                              unauth'd DLRs.
//   - 401 unauthorized       — bearer token missing or wrong.
//   - 400 bad_json           — request body wasn't valid JSON.
//   - 400 bad_payload        — parser returned a structural failure
//                              (missing id / missing status / malformed
//                              envelope). NOT used for the "ignore"
//                              path — Taqnyat would keep retrying a
//                              400 indefinitely, and intermediate
//                              states aren't errors.
//   - 200 {ok:true, noted:"intermediate"}   — parsed fine but not a
//                                             terminal transition (sent
//                                             / queued / accepted / read).
//                                             Ack so provider stops
//                                             retrying.
//   - 200 {ok:true, noted:"unknown_id"}     — providerId doesn't match
//                                             any Invitation. Idempotent
//                                             — matches the existing
//                                             /api/webhooks/delivery
//                                             contract so providers can
//                                             fire-and-forget.
//   - 200 {ok:true, noted:"no_change"}      — state machine rejected
//                                             the transition (idempotent
//                                             replay, or regression from
//                                             terminal delivered).
//   - 200 {ok:true, applied:true, ...}      — wrote Invitation +
//                                             EventLog.

export type TaqnyatWebhookResult = {
  status: number;
  body: Record<string, unknown>;
};

// The minimal Invitation shape the state machine needs. Matches
// what Prisma's findFirst returns when we `select` these columns.
export type InvitationRow = {
  id: string;
  status: string;
  deliveredAt: Date | null;
};

export interface TaqnyatWebhookDeps {
  // Returns the configured shared secret, or undefined if unset. In
  // production this reads process.env.TAQNYAT_WEBHOOK_SECRET. Kept
  // as a callback (not a string) so env isn't captured at module
  // load time — tests flip it per-case.
  getSecret: () => string | undefined;
  // Ownership-free lookup by providerId. Unlike the dispatch path's
  // session-owned queries, a DLR webhook has no authenticated user —
  // Taqnyat writes for ALL operators' sends. providerId is the only
  // join key available.
  findInvitation: (providerId: string) => Promise<InvitationRow | null>;
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

// Accepted header names for the shared bearer.
//
// Why two: Taqnyat's webhook config UI hasn't been pinned by our ops,
// so we don't know yet whether they'll post `Authorization: Bearer X`
// (matching their send API's auth pattern) or a custom `x-taqnyat-
// secret: X`. Accepting both means the route works whichever setting
// the operator picks without a round-trip to re-deploy. `secretMatches`
// constant-time compares, so accepting two header names doesn't open
// a timing side channel.
const AUTH_HEADERS = ["authorization", "x-taqnyat-secret"] as const;

export async function handleTaqnyatDeliveryWebhook(
  req: Request,
  parse: (body: unknown) => TaqnyatDlrParse,
  channel: "sms" | "whatsapp",
  deps: TaqnyatWebhookDeps,
): Promise<TaqnyatWebhookResult> {
  const secret = deps.getSecret();
  if (!secret) {
    return { status: 503, body: { ok: false, error: "not_configured" } };
  }

  // Extract the bearer. Case-insensitive header lookup — Node normalizes
  // header names to lowercase, but we use req.headers.get() which
  // handles that for us. The Authorization header value is either the
  // bare token or `Bearer <token>`; strip the prefix if present.
  let sent = "";
  for (const name of AUTH_HEADERS) {
    const v = req.headers.get(name);
    if (v) {
      sent = v.startsWith("Bearer ") ? v.slice(7) : v;
      break;
    }
  }
  if (!secretMatches(sent, secret)) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }

  // Read raw body first (so `.json()` doesn't throw on an empty /
  // malformed body). Parse manually — we want a 400 rather than a
  // Next runtime exception.
  const raw = await req.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, body: { ok: false, error: "bad_json" } };
  }

  const parsed = parse(body);
  if (!parsed.ok) {
    if (parsed.reason === "ignore") {
      // Intermediate states: 200 OK so Taqnyat stops retrying. No DB
      // writes, no EventLog.
      return { status: 200, body: { ok: true, noted: "intermediate" } };
    }
    // Structural failure. 400 is the right code for the provider to
    // see — it signals "your payload is broken." We include the
    // reason string so debugging can happen from the access logs
    // without needing to read the body back.
    return {
      status: 400,
      body: { ok: false, error: "bad_payload", reason: parsed.reason },
    };
  }

  const inv = await deps.findInvitation(parsed.providerId);
  if (!inv) {
    // Unknown providerId — idempotent 200, same as the existing
    // /api/webhooks/delivery contract. Most common cause: a DLR
    // for a send that predated this deploy, or a test message from
    // the Taqnyat dashboard.
    return {
      status: 200,
      body: { ok: true, noted: "unknown_id" },
    };
  }

  const transition = decideDeliveryTransition(
    { status: inv.status, deliveredAt: inv.deliveredAt },
    { status: parsed.status, error: parsed.error },
    deps.now(),
  );
  if (!transition.shouldUpdate) {
    return {
      status: 200,
      body: { ok: true, noted: "no_change" },
    };
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
      providerId: parsed.providerId,
      status: transition.nextStatus,
      error: transition.nextError ?? null,
      channel: `taqnyat-${channel}`,
    }),
  });
  return {
    status: 200,
    body: { ok: true, applied: true, status: transition.nextStatus },
  };
}
