import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { logAction } from "@/lib/audit";
import { buildToolCtx } from "@/lib/ai/ctx";
import { dispatch } from "@/lib/ai/tools";
import { runConfirmSend } from "@/lib/ai/confirm-flow";
import { runConfirmImport } from "@/lib/ai/confirm-import-flow";
import { focusWidget, upsertWidget } from "@/lib/ai/widgets";
import {
  confirmSendWidgetKey,
  confirmImportWidgetKey,
} from "@/lib/ai/widgetKeys";
import { refreshWorkspaceSummary } from "@/lib/ai/workspace-summary";

// The confirmation endpoint for destructive AI actions.
//
// Two destructive flows share this route: `send_campaign` (anchored
// by `propose_send`) and `commit_import` (anchored by `propose_import`).
// The route branches on `row.toolName` after the common pre-claim
// pre-checks (wrong_tool / anchor_was_error / corrupt_input /
// already_confirmed) and hands off to the matching pure-core flow
// (`runConfirmSend` or `runConfirmImport`).
//
// Flow (generic):
//   1. During a chat turn, the model calls a propose_* tool. The tool
//      handler computes the preview and emits the matching
//      `confirm_send` / `confirm_import` widget; the chat route
//      persists the tool row AND threads that row's id into the
//      directive envelope as `messageId`.
//   2. The widget renders with the messageId and a button that POSTs
//      here.
//   3. We atomically claim the anchor row (`confirmedAt: null` → now),
//      then re-dispatch the destructive tool with
//      `allowDestructive: true`, using the input stored on that
//      messageId row (never the client's POST body — see "trust
//      model" below).
//   4. On success we persist the summary as a new role="assistant"
//      ChatMessage so the transcript stays coherent; audit under
//      `ai.confirm.<destructiveTool>`. The client morphs the card
//      in place from the JSON response.
//   5. On a structured-refusal path whose code is on the flow's
//      releasable whitelist (every one of which refuses BEFORE the
//      real write begins), we release the claim so the operator can
//      retry. On a dispatch-throw or a refusal inside the write path,
//      the claim stays — retrying would either re-send / re-write
//      partial state or duplicate a completed action.
//
// Trust model — why the POST takes no body:
//   - The operator's click authorizes EXECUTING the proposal, not
//     redefining it. The preview the model resolved, persisted, and
//     rendered is what gets committed. Accepting new body fields
//     would open swap-the-target attacks.
//   - messageId in the URL is the authorization anchor: ownership is
//     enforced via a session-join (see the `where` below), not via a
//     separately-supplied user id.
//
// Idempotency — single-use anchor:
//   - Without a server-side gate, a repeat POST against the same
//     messageId (retry after transient error, browser back/forward,
//     forged request, or a future client that rehydrates stale
//     directives) would re-dispatch the destructive tool and really
//     re-execute. The widget "button hidden after success" is local
//     React state only and cannot defend against this.
//   - The atomic claim via
//     `updateMany({where: {id, confirmedAt: null}, data: {confirmedAt: now}})`
//     is race-safe: two concurrent clicks see ONE winner (count=1)
//     and ONE loser (count=0 → already_confirmed audit + 409).
//   - Release is whitelisted per-flow: see
//     `RELEASABLE_REFUSALS` (send) and `RELEASABLE_IMPORT_REFUSALS`
//     (import) in `src/lib/ai/confirm-classify.ts` for the rationale
//     on which refusal codes qualify.
//
// Audit shape:
//   - `ai.confirm.<destructiveTool>` on attempted dispatch. `data.ok`
//     reflects the EFFECTIVE outcome (not just whether dispatch
//     returned), so a structured refusal records `ok: false` with
//     the handler's error as `data.error`.
//   - `ai.denied.<destructiveTool>` on pre-dispatch denials at this
//     route layer (stale id, corrupt input, anchor was itself an
//     error, anchor already confirmed). These are things the
//     dispatcher never sees, so they need a separate audit kind.
//   - `ai.denied.confirm` is the catch-all for the wrong_tool case
//     where `row.toolName` isn't a known proposal anchor — we don't
//     know which destructive tool the attempt was targeting, so the
//     per-tool kinds don't apply.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Per-anchor config table. Keyed by the proposal tool name stored on
// the ChatMessage row. Adding a new destructive flow (e.g. a future
// propose_archive) requires: (1) a new entry here, (2) a new pure-core
// flow module + its ConfirmPort bindings in the branch below, (3) the
// matching widget kind in `widget-validate.ts::WIDGET_KINDS`. Keeping
// the map typed as a closed literal is what lets TypeScript catch a
// "we added the flow but forgot to wire up audit kinds" regression.
type AnchorConfig = {
  destructiveTool: "send_campaign" | "commit_import";
  confirmAuditKind: "ai.confirm.send_campaign" | "ai.confirm.commit_import";
  deniedAuditKind: "ai.denied.send_campaign" | "ai.denied.commit_import";
};

const ANCHOR_MAP: Record<string, AnchorConfig> = {
  propose_send: {
    destructiveTool: "send_campaign",
    confirmAuditKind: "ai.confirm.send_campaign",
    deniedAuditKind: "ai.denied.send_campaign",
  },
  propose_import: {
    destructiveTool: "commit_import",
    confirmAuditKind: "ai.confirm.commit_import",
    deniedAuditKind: "ai.denied.commit_import",
  },
};

// The destructive-action core — claim, dispatch, classify, release,
// audit, persist, respond — lives in `src/lib/ai/confirm-flow.ts`
// (send) and `src/lib/ai/confirm-import-flow.ts` (import) behind
// dependency-injectable ports. The route below handles auth, rate
// limiting, row lookup, pre-claim pre-checks (wrong_tool /
// anchor_was_error / corrupt_input), and then hands off to the
// matching runner. See `tests/unit/confirm-single-use.test.ts` and
// `tests/unit/confirm-outcome.test.ts` for the regression coverage
// that extraction enables.

export async function POST(
  _req: Request,
  { params }: { params: { messageId: string } },
) {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  // Share the chat bucket. Operators who hammer Confirm share the
  // same burst budget as their chat turns — both end up doing a
  // handler dispatch, so the cost profile matches.
  const rl = rateLimit(`chat:${me.id}`, { capacity: 8, refillPerSec: 0.3 });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retryAfterMs: rl.retryAfterMs },
      { status: 429 },
    );
  }

  const messageId = params.messageId;
  if (typeof messageId !== "string" || messageId.length === 0) {
    return NextResponse.json(
      { ok: false, error: "bad_message_id" },
      { status: 400 },
    );
  }

  // Ownership check via session join. A row belonging to a different
  // user's session collapses to `not_found` — not `forbidden` — so
  // an attacker can't probe for valid message ids.
  const row = await prisma.chatMessage.findFirst({
    where: {
      id: messageId,
      role: "tool",
      session: { userId: me.id },
    },
    select: {
      id: true,
      sessionId: true,
      toolName: true,
      toolInput: true,
      isError: true,
      confirmedAt: true,
    },
  });
  if (!row) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 },
    );
  }

  // Only known proposal tools are valid confirmation anchors. The
  // ANCHOR_MAP entry also decides which audit kinds (and below,
  // which pure-core runner) this request routes through.
  const anchorConfig = row.toolName ? ANCHOR_MAP[row.toolName] : undefined;
  if (!anchorConfig) {
    // We don't know which destructive tool the attempt targeted, so
    // the per-tool denied kind doesn't apply. Use the generic
    // `ai.denied.confirm` so these events stay greppable but don't
    // pollute the per-tool stream.
    await logAction({
      kind: "ai.denied.confirm",
      refType: "ChatSession",
      refId: row.sessionId,
      actorId: me.id,
      data: {
        via: "confirm",
        reason: "wrong_tool",
        messageId,
        toolName: row.toolName,
      },
    });
    return NextResponse.json(
      { ok: false, error: "wrong_tool" },
      { status: 400 },
    );
  }

  // If the anchor row ITSELF was an error (e.g. propose_send /
  // propose_import returned `forbidden` or `not_found`), there's no
  // coherent destructive action to confirm — something likely went
  // wrong on the UI side letting the button render at all. Refuse
  // loudly rather than re-dispatching blind.
  if (row.isError) {
    await logAction({
      kind: anchorConfig.deniedAuditKind,
      refType: "ChatSession",
      refId: row.sessionId,
      actorId: me.id,
      data: { via: "confirm", reason: "anchor_was_error", messageId },
    });
    return NextResponse.json(
      { ok: false, error: "anchor_was_error" },
      { status: 400 },
    );
  }

  // Fast-path already_confirmed — skip toolInput parse + buildToolCtx
  // when we already know the anchor is taken. Not race-safe on its
  // own (two parallel reads can both see confirmedAt=null); the
  // atomic claim inside each runConfirm* is the real guard. This
  // exists purely so the common "refreshed the tab, clicked again"
  // case returns 409 without doing the relatively expensive input
  // parse and ctx build. runConfirm* repeats the same check for
  // defense-in-depth; the single-use tests pin the check there.
  if (row.confirmedAt) {
    await logAction({
      kind: anchorConfig.deniedAuditKind,
      refType: "ChatSession",
      refId: row.sessionId,
      actorId: me.id,
      data: {
        via: "confirm",
        reason: "already_confirmed",
        messageId,
        confirmedAt: row.confirmedAt.toISOString(),
      },
    });
    return NextResponse.json(
      { ok: false, error: "already_confirmed" },
      { status: 409 },
    );
  }

  // Recover the stored proposal input. For propose_send it's a
  // SUPERSET-compatible pass-through for send_campaign (campaign_id,
  // channel, only_unsent); for propose_import it's the same
  // {ingestId, target, campaign_id?} shape commit_import's validate()
  // expects. Either way the destructive tool's validate() rejects
  // anything unexpected, so a forged / drifted toolInput fails
  // cleanly in dispatch rather than landing a bad write.
  let parsedInput: unknown = {};
  if (row.toolInput) {
    try {
      parsedInput = JSON.parse(row.toolInput);
    } catch {
      await logAction({
        kind: anchorConfig.deniedAuditKind,
        refType: "ChatSession",
        refId: row.sessionId,
        actorId: me.id,
        data: { via: "confirm", reason: "corrupt_input", messageId },
      });
      return NextResponse.json(
        { ok: false, error: "corrupt_input" },
        { status: 400 },
      );
    }
  }

  const ctx = await buildToolCtx(me);

  // Branch on toolName — the pure-core flow, its outcome shape, its
  // releasable-refusals whitelist, and its widget key formula all
  // differ between send and import. The port seam hides those
  // differences from the flows themselves; the route is where the
  // two shapes visibly diverge.
  let status: number;
  let body: Record<string, unknown>;
  if (row.toolName === "propose_send") {
    ({ status, body } = await runConfirmSend(
      { id: row.id, sessionId: row.sessionId, confirmedAt: row.confirmedAt },
      messageId,
      parsedInput,
      ctx,
      {
        claim: () =>
          prisma.chatMessage.updateMany({
            where: { id: row.id, confirmedAt: null },
            data: { confirmedAt: new Date() },
          }),
        release: async () => {
          await prisma.chatMessage.updateMany({
            where: { id: row.id },
            data: { confirmedAt: null },
          });
        },
        dispatchSend: (input, c) =>
          dispatch("send_campaign", input, c, { allowDestructive: true }),
        persistTranscript: async ({ sessionId, content, isError }) => {
          await prisma.chatMessage.create({
            data: { sessionId, role: "assistant", content, isError },
          });
        },
        auditConfirm: ({ sessionId, data }) =>
          logAction({
            kind: anchorConfig.confirmAuditKind,
            refType: "ChatSession",
            refId: sessionId,
            actorId: me.id,
            data,
          }),
        auditDenied: ({ sessionId, data }) =>
          logAction({
            kind: anchorConfig.deniedAuditKind,
            refType: "ChatSession",
            refId: sessionId,
            actorId: me.id,
            data,
          }),
        // W5 — write the post-dispatch terminal state onto the
        // `confirm.send.${campaign_id}` widget row. We recover the
        // campaign id from the same stored toolInput the dispatcher
        // uses, so the widget key agrees with the one propose_send
        // emitted. A missing campaign_id (shouldn't happen —
        // propose_send requires it) leaves the widget untouched.
        markConfirmSendOutcome: async (outcome) => {
          const campaignId =
            parsedInput &&
            typeof parsedInput === "object" &&
            !Array.isArray(parsedInput) &&
            typeof (parsedInput as Record<string, unknown>).campaign_id ===
              "string"
              ? ((parsedInput as Record<string, unknown>).campaign_id as string)
              : null;
          if (!campaignId) return;
          const widgetKey = confirmSendWidgetKey(campaignId);
          const existing = await focusWidget(
            { prismaLike: prisma },
            row.sessionId,
            widgetKey,
          );
          if (!existing) return;
          const nextProps: Record<string, unknown> = { ...existing.props };
          delete nextProps.result;
          delete nextProps.error;
          delete nextProps.summary;
          nextProps.state = outcome.state;
          if (outcome.state === "done") {
            nextProps.result = outcome.result;
          } else {
            nextProps.error = outcome.error;
          }
          if (outcome.summary) nextProps.summary = outcome.summary;
          await upsertWidget(
            { prismaLike: prisma },
            {
              sessionId: row.sessionId,
              widgetKey: existing.widgetKey,
              kind: existing.kind,
              slot: existing.slot,
              props: nextProps,
              order: existing.order,
              sourceMessageId: existing.sourceMessageId,
            },
          );
        },
      },
    ));
  } else {
    // propose_import — the only other entry in ANCHOR_MAP right now.
    // Narrowed by the `anchorConfig.destructiveTool === "commit_import"`
    // invariant; any future entry would need its own branch (and
    // runConfirm* module).
    ({ status, body } = await runConfirmImport(
      { id: row.id, sessionId: row.sessionId, confirmedAt: row.confirmedAt },
      messageId,
      parsedInput,
      ctx,
      {
        claim: () =>
          prisma.chatMessage.updateMany({
            where: { id: row.id, confirmedAt: null },
            data: { confirmedAt: new Date() },
          }),
        release: async () => {
          await prisma.chatMessage.updateMany({
            where: { id: row.id },
            data: { confirmedAt: null },
          });
        },
        dispatchCommit: (input, c) =>
          dispatch("commit_import", input, c, { allowDestructive: true }),
        persistTranscript: async ({ sessionId, content, isError }) => {
          await prisma.chatMessage.create({
            data: { sessionId, role: "assistant", content, isError },
          });
        },
        auditConfirm: ({ sessionId, data }) =>
          logAction({
            kind: anchorConfig.confirmAuditKind,
            refType: "ChatSession",
            refId: sessionId,
            actorId: me.id,
            data,
          }),
        auditDenied: ({ sessionId, data }) =>
          logAction({
            kind: anchorConfig.deniedAuditKind,
            refType: "ChatSession",
            refId: sessionId,
            actorId: me.id,
            data,
          }),
        // Terminal-state writer for the confirm_import widget. Key
        // formula is `confirm.import.<target>.<ingestId>` — we pull
        // target + ingestId off the same parsedInput the dispatcher
        // forwards to commit_import, so the widget key agrees with
        // the one propose_import emitted. A missing / malformed pair
        // (shouldn't happen — both tools' validators reject it)
        // leaves the widget untouched; the operator sees the pre-
        // action state on next reload and the single-use anchor
        // prevents a second commit.
        markConfirmImportOutcome: async (outcome) => {
          const rec =
            parsedInput &&
            typeof parsedInput === "object" &&
            !Array.isArray(parsedInput)
              ? (parsedInput as Record<string, unknown>)
              : null;
          if (!rec) return;
          const target = rec.target;
          const ingestId = rec.ingestId;
          if (
            (target !== "contacts" && target !== "invitees") ||
            typeof ingestId !== "string" ||
            ingestId.length === 0
          ) {
            return;
          }
          const widgetKey = confirmImportWidgetKey(target, ingestId);
          const existing = await focusWidget(
            { prismaLike: prisma },
            row.sessionId,
            widgetKey,
          );
          if (!existing) return;
          const nextProps: Record<string, unknown> = { ...existing.props };
          delete nextProps.result;
          delete nextProps.error;
          delete nextProps.summary;
          nextProps.state = outcome.state;
          if (outcome.state === "done") {
            nextProps.result = outcome.result;
          } else {
            nextProps.error = outcome.error;
          }
          if (outcome.summary) nextProps.summary = outcome.summary;
          await upsertWidget(
            { prismaLike: prisma },
            {
              sessionId: row.sessionId,
              widgetKey: existing.widgetKey,
              kind: existing.kind,
              slot: existing.slot,
              props: nextProps,
              order: existing.order,
              sourceMessageId: existing.sourceMessageId,
            },
          );
        },
      },
    ));
  }

  // W7 — refresh the workspace rollup after a successful destructive
  // action. Both flows move counters the rollup tracks: a send moves
  // `invitations.sent_24h`; an import moves `invitees.total` (or
  // creates Contact rows for the operator's contact book). Gated on
  // HTTP 200 so we only refresh on the true-success path —
  // structured refusals (blockers, forbidden, etc.) land as 400 with
  // `body.ok: false` and don't move counters; dispatch-throws keep
  // the anchor claimed and also don't refresh (wasted work, and the
  // next real action will refresh anyway). Errors are swallowed by
  // design: the operator already got their outcome in `body`, and a
  // stale rollup surfaces in a later snapshot once the next mutation
  // refreshes.
  if (status === 200) {
    try {
      await refreshWorkspaceSummary(
        { prismaLike: prisma as never },
        { sessionId: row.sessionId, campaignScope: ctx.campaignScope },
      );
    } catch (err) {
      console.warn(`[confirm] workspace rollup refresh failed`, err);
    }
  }

  return NextResponse.json(body, { status });
}
