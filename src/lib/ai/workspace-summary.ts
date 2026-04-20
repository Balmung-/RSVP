import type { Prisma } from "@prisma/client";
import { WORKSPACE_SUMMARY_WIDGET_KEY } from "./widgetKeys";
import {
  upsertWidget,
  type PrismaLike as WidgetsPrismaLike,
  type Widget,
} from "./widgets";

// W7 — server-owned workspace rollup helper.
//
// The rollup is a single persistent `workspace_rollup` widget pinned
// to the `summary` slot via the stable `workspace.summary` key. It is
// NOT produced by any tool handler — no model call can emit this
// kind, and the `widget_upsert` path from the tool dispatch layer is
// firewalled from it (the closed-registry validator accepts the kind
// only because THIS module needs to write it).
//
// Why server-owned, not client-derived from existing widgets:
//   - The in-memory widget list the client has is a subset — it only
//     contains widgets the operator has caused via the transcript
//     ("show campaigns", "list contacts", etc). A workspace with 200
//     campaigns but zero tool calls would report zero campaigns on
//     the rollup, which is wrong.
//   - The rollup's authority is the DB, not the chat-local state.
//     Refreshing on the server with `ctx.campaignScope` threaded in
//     means every operator sees their own scope-correct numbers; an
//     admin sees the office total, a non-admin sees only their team's
//     campaigns plus office-wide (teamId = null).
//
// Scope composition rule — `campaignScope` is
// `Prisma.CampaignWhereInput` and may carry a top-level `OR` for the
// non-admin team filter. NEVER spread it with another top-level OR
// (see the Push 2 audit note in `tools/types.ts`); always AND with
// the other clauses. Helper relations on Invitee / Response /
// Invitation accept a CampaignWhereInput directly, so `campaign:
// campaignScope` is safe (no collision, no nested OR to clobber).
//
// Refresh cadence — see callsites:
//   - `src/app/api/chat/route.ts` after a successful `draft_campaign`
//     tool run (the only write-scope tool that moves rollup counters
//     today). The emitter path emits `widget_upsert` over SSE so the
//     dashboard updates live in the same chat turn.
//   - `src/app/api/chat/confirm/[messageId]/route.ts` after a
//     successful send dispatch. No SSE channel here — the rollup row
//     lands in the DB and is picked up by the next
//     `workspace_snapshot` emit (session reload, or the next chat
//     turn's opening snapshot).

// ---- counter shape ----
//
// Every field is an integer; missing / NaN / Infinity will not be
// produced by the computer (counts come straight from Prisma) but
// `validateWorkspaceRollup` rejects non-integer values anyway for
// read-side drift protection.
export type WorkspaceRollupProps = {
  campaigns: {
    draft: number;
    active: number;
    closed: number;
    archived: number;
    total: number;
  };
  invitees: { total: number };
  responses: {
    total: number;
    attending: number;
    declined: number;
    recent_24h: number;
  };
  // P13-E — `sent_24h` is the channel-agnostic aggregate kept for the
  // compact "how much went out today" read. The three per-channel
  // counters join it so the operator can see the WhatsApp rollout
  // progress on the same strip that already shows email/SMS. We keep
  // both the aggregate AND the breakdown rather than deriving one from
  // the other: an authoritative aggregate lets a future channel land
  // (e.g. push notifications) without silently under-counting the
  // total until the validator + renderer catch up, and an explicit
  // breakdown removes the "is it really three channels or was one
  // dropped" ambiguity the `Xe / Ys / Zw` campaign_card row also
  // answers.
  invitations: {
    sent_24h: number;
    sent_email_24h: number;
    sent_sms_24h: number;
    sent_whatsapp_24h: number;
  };
  generated_at: string;
};

// ---- dep-injection surface ----
//
// Counter methods we touch. `PrismaLike` from `widgets.ts` covers the
// `chatWidget` write — extend it here with the four counter tables so
// the full seam lives in one type. Unit tests stub every method; the
// production caller passes the real prisma client.
export type WorkspaceSummaryPrismaLike = WidgetsPrismaLike & {
  campaign: {
    count(args: { where: Prisma.CampaignWhereInput }): Promise<number>;
    groupBy(args: {
      by: ["status"];
      where: Prisma.CampaignWhereInput;
      _count: { _all: true };
    }): Promise<Array<{ status: string; _count: { _all: number } }>>;
  };
  invitee: {
    count(args: { where: Prisma.InviteeWhereInput }): Promise<number>;
  };
  response: {
    count(args: { where: Prisma.ResponseWhereInput }): Promise<number>;
  };
  invitation: {
    count(args: { where: Prisma.InvitationWhereInput }): Promise<number>;
  };
};

// ---- compute ----
//
// Pure function over the injected prisma + scope. Returns the full
// props object ready to hand to `upsertWidget`. `now` is injectable
// for tests so the 24h cutoff is deterministic; production callers
// omit and get `new Date()`.
export async function computeWorkspaceRollup(
  prismaLike: WorkspaceSummaryPrismaLike,
  campaignScope: Prisma.CampaignWhereInput,
  now: Date = new Date(),
): Promise<WorkspaceRollupProps> {
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // One groupBy handles all four campaign statuses in a single
  // query. `status` is a free-text string in the schema (`draft |
  // active | closed | archived` by convention); any row with an
  // unrecognised value falls out of the four buckets but still
  // contributes to `total` via the separate count below.
  // Shared base for every Invitation count below — status whitelist +
  // campaign scope + 24h cutoff. Extracted so a future channel addition
  // only needs a new channel-filtered entry rather than touching four
  // clauses. Each per-channel count adds `channel: "..."` on top.
  const inv24hBase: Prisma.InvitationWhereInput = {
    campaign: campaignScope,
    status: { in: ["sent", "delivered"] },
    sentAt: { gte: cutoff24h },
  };
  const [
    statusGroups,
    campaignTotal,
    inviteeTotal,
    responseTotal,
    attending,
    declined,
    recent24h,
    sent24h,
    sentEmail24h,
    sentSms24h,
    sentWhatsApp24h,
  ] = await Promise.all([
    prismaLike.campaign.groupBy({
      by: ["status"],
      where: campaignScope,
      _count: { _all: true },
    }),
    prismaLike.campaign.count({ where: campaignScope }),
    // Invitee / Response / Invitation all have a `campaign` relation
    // filter that accepts a CampaignWhereInput directly — passing
    // `campaignScope` at that nesting level is safe because any
    // top-level OR in the scope lives inside the relation filter,
    // not at the top of the Invitee / Response / Invitation where.
    prismaLike.invitee.count({ where: { campaign: campaignScope } }),
    prismaLike.response.count({ where: { campaign: campaignScope } }),
    prismaLike.response.count({
      where: { campaign: campaignScope, attending: true },
    }),
    prismaLike.response.count({
      where: { campaign: campaignScope, attending: false },
    }),
    prismaLike.response.count({
      where: {
        campaign: campaignScope,
        respondedAt: { gte: cutoff24h },
      },
    }),
    // Send-sensitive counter: `sent_24h` is what makes this rollup
    // "send-sensitive" and is the reason the confirm route calls the
    // refresh helper after a successful dispatch. We count Invitations
    // whose status reached sent/delivered in the last 24 hours; a
    // `failed` or `bounced` row doesn't count because it's not a
    // successful delivery from the operator's perspective.
    //
    // P13-E — `sent_24h` stays as the channel-agnostic aggregate
    // (still the right number for "anything went out in 24h"). The
    // three per-channel counts below run as separate queries filtered
    // on `channel` so the rollup shows the same Xe / Ys / Zw split
    // that `campaign_card` gained in D.3. A single groupBy would be
    // cheaper, but it would require a second aggregate pass to
    // compute the total — keeping the aggregate as its own query
    // means the total stays honest even if a future channel lands
    // before the per-channel counters are updated.
    prismaLike.invitation.count({ where: inv24hBase }),
    prismaLike.invitation.count({
      where: { ...inv24hBase, channel: "email" },
    }),
    prismaLike.invitation.count({
      where: { ...inv24hBase, channel: "sms" },
    }),
    prismaLike.invitation.count({
      where: { ...inv24hBase, channel: "whatsapp" },
    }),
  ]);

  const campaigns = {
    draft: 0,
    active: 0,
    closed: 0,
    archived: 0,
    total: campaignTotal,
  };
  for (const g of statusGroups) {
    if (
      g.status === "draft" ||
      g.status === "active" ||
      g.status === "closed" ||
      g.status === "archived"
    ) {
      campaigns[g.status] = g._count._all;
    }
  }

  // Pending is derivable as `inviteeTotal - responseTotal`, but we
  // keep it out of the blob because the operator can compute it by
  // eye from the two numbers shown, and omitting it keeps the
  // validator narrow.

  return {
    campaigns,
    invitees: { total: inviteeTotal },
    responses: {
      total: responseTotal,
      attending,
      declined,
      recent_24h: recent24h,
    },
    invitations: {
      sent_24h: sent24h,
      sent_email_24h: sentEmail24h,
      sent_sms_24h: sentSms24h,
      sent_whatsapp_24h: sentWhatsApp24h,
    },
    generated_at: now.toISOString(),
  };
}

// ---- refresh ----
//
// Compute + upsert. Returns the persisted `Widget` (same shape the
// workspace emitter's `widget_upsert` frame carries) on success, or
// null if the validator rejected the produced props. A null return is
// a programming bug — the compute function produces a validated shape
// by construction — but we surface it so callers can log and skip
// rather than treat the refresh as having happened.
export async function refreshWorkspaceSummary(
  deps: { prismaLike: WorkspaceSummaryPrismaLike },
  args: {
    sessionId: string;
    campaignScope: Prisma.CampaignWhereInput;
    now?: Date;
  },
): Promise<Widget | null> {
  const props = await computeWorkspaceRollup(
    deps.prismaLike,
    args.campaignScope,
    args.now,
  );
  return upsertWidget(
    { prismaLike: deps.prismaLike },
    {
      sessionId: args.sessionId,
      widgetKey: WORKSPACE_SUMMARY_WIDGET_KEY,
      kind: "workspace_rollup",
      slot: "summary",
      props,
      // `order: 0` pins the rollup to the top of the summary slot.
      // No other widget writes into `summary` today, so the order
      // value is belt-and-braces for a future summary widget that
      // wants to sit below the rollup.
      order: 0,
      // The rollup has no anchoring message id — it is not produced
      // by a tool call. null is the correct value; `upsertWidget`
      // normalises absent/undefined to null anyway.
      sourceMessageId: null,
    },
  );
}

// ---- P14-A: route-trigger helpers ----
//
// The chat route fires a refresh after a counter-moving tool call; the
// confirm route fires a refresh after a successful destructive dispatch.
// Both gates used to live inline as `if (call.name === "draft_campaign")`
// / `if (status === 200)` branches with their own try/catch and null
// handling — small, but impossible to unit-test without spinning up
// the Next.js runtime around them. Extracting the gate+refresh+catch
// into a single pure function with a discriminated-union outcome means:
//
//   - The route becomes a thin outcome-to-side-effect switch (emit SSE,
//     log warning, or no-op); the gate condition, the error-swallow
//     posture, and the "is the compute result even valid" check all sit
//     under unit tests.
//   - A regression that widens / narrows either gate (e.g. "also
//     refresh on commit_import in the chat route") has to update one
//     function + its pin, not search-replace two route files.
//   - The "invalid" branch (compute produced something the validator
//     rejected) stays a belt-and-braces path — it can only be reached
//     today by a refactor in `computeWorkspaceRollup` that breaks the
//     produces-validated-shape-by-construction contract, but the
//     outcome type makes the existence of that branch grep-visible
//     instead of buried inside a conditional.
//
// Keep both helpers alongside `refreshWorkspaceSummary` (not in the
// routes) so the full refresh surface lives in one file — anyone
// reading this module sees the full lifecycle (compute → refresh →
// trigger-gate) before jumping into either route.

// Outcome shape shared by both trigger helpers.
//
//   - `skipped`  — the gate predicate returned false; no compute ran.
//                  The caller must do nothing (no emit, no log).
//   - `produced` — compute + upsert landed and returned a real widget
//                  row. The caller emits `widget_upsert` (chat route)
//                  or relies on the next `workspace_snapshot` (confirm
//                  route — no SSE channel open there).
//   - `invalid`  — compute returned props that upsertWidget's internal
//                  validateWidget rejected. Defensive branch; the
//                  caller logs and drops.
//   - `error`    — refreshWorkspaceSummary threw (usually a prisma
//                  failure). The error is preserved on the outcome so
//                  the caller can log it with the right prefix rather
//                  than the helper owning a tag the test can't pin.
export type SummaryRefreshOutcome =
  | { kind: "skipped" }
  | { kind: "produced"; widget: Widget }
  | { kind: "invalid" }
  | { kind: "error"; error: unknown };

// Set of tool-call names that move rollup counters in a way the chat
// route can refresh (i.e. the handler wrote to the DB on this turn).
// Exported as a readonly tuple so the pin below can iterate the full
// set — a new entry has to show up both in the route wiring and in the
// test's "triggers refresh" loop, catching the half-landed regression
// where someone wires the gate but forgets the test (or vice versa).
//
// `draft_campaign` is the only entry today — `send_campaign` and
// `commit_import` are destructive and intercepted by dispatch() on the
// chat route; their real writes happen via the confirm route, which
// has its own helper below.
export const CHAT_TOOLS_REFRESHING_SUMMARY = ["draft_campaign"] as const;

export type ChatToolRefreshingSummary =
  (typeof CHAT_TOOLS_REFRESHING_SUMMARY)[number];

function isChatToolRefreshingSummary(
  name: string,
): name is ChatToolRefreshingSummary {
  return (CHAT_TOOLS_REFRESHING_SUMMARY as readonly string[]).includes(name);
}

// Called from the chat route after a tool dispatch returns OK. Fires
// the refresh only when the tool was one of the counter-movers listed
// above; every other tool (read-only, destructive-intercepted, or just
// not touching the rollup's counters) is a no-op so the route doesn't
// waste a query on every turn.
export async function tryRefreshSummaryForChatTool(
  deps: { prismaLike: WorkspaceSummaryPrismaLike },
  args: {
    sessionId: string;
    campaignScope: Prisma.CampaignWhereInput;
    now?: Date;
  },
  toolName: string,
): Promise<SummaryRefreshOutcome> {
  if (!isChatToolRefreshingSummary(toolName)) return { kind: "skipped" };
  try {
    const rollup = await refreshWorkspaceSummary(deps, args);
    if (rollup === null) return { kind: "invalid" };
    return { kind: "produced", widget: rollup };
  } catch (error) {
    return { kind: "error", error };
  }
}

// Called from the confirm route after the destructive dispatch returns.
// Fires the refresh only on the true-success path (HTTP 200); every
// other status either released the anchor (retryable refusal) or held
// the claim (dispatch-throw / in-write refusal), and neither moved
// counters. A non-200 refresh would run queries for nothing AND emit
// a misleading "fresh" timestamp to the operator.
export async function tryRefreshSummaryForConfirm(
  deps: { prismaLike: WorkspaceSummaryPrismaLike },
  args: {
    sessionId: string;
    campaignScope: Prisma.CampaignWhereInput;
    now?: Date;
  },
  status: number,
): Promise<SummaryRefreshOutcome> {
  if (status !== 200) return { kind: "skipped" };
  try {
    const rollup = await refreshWorkspaceSummary(deps, args);
    if (rollup === null) return { kind: "invalid" };
    return { kind: "produced", widget: rollup };
  } catch (error) {
    return { kind: "error", error };
  }
}
