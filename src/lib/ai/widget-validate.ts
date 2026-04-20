// Server-side validate-per-kind for ChatWidget rows.
//
// This is the `directive-validate.ts` sibling, specialised for the
// workspace dashboard. See `prisma/schema.prisma` (ChatWidget model)
// for the full rationale — the short version:
//
//   Directives are TRANSIENT — emitted per assistant turn, rendered
//   inline, discarded on reload unless the transcript replays them.
//   Widgets are PERSISTENT — they live in their own table keyed by
//   `(sessionId, widgetKey)`, they upsert in place when the same
//   tool is invoked again, and they are reloaded whole on every
//   session open.
//
//   The persistence changes the trust model. With directives, the
//   producer tool wrote the blob in the same request that rendered
//   it — any drift showed up immediately. With widgets, a blob can
//   sit in the DB for weeks before someone opens the session, and
//   when they do the client does `JSON.parse(widget.props) as
//   XProps` with zero runtime guard. That's the exact boundary
//   directive-validate.ts was built for; widget-validate.ts closes
//   the same gap on the widget table.
//
// Design constraints:
//   1. Pure function, no I/O. Unit-tested in
//      `tests/unit/widget-validate.test.ts` with fake payloads; no
//      DB, no Anthropic.
//   2. CLOSED `kind` registry — currently the same six kinds the
//      directive renderer knows about. Widgets and directives
//      happen to share prop shapes today because W3 is a pure move
//      (tools stop emitting directives, they upsert widgets
//      instead). Keep these validators independent of
//      directive-validate.ts so future divergence — a widget-only
//      kind, a directive-only kind — doesn't require touching both
//      files.
//   3. CLOSED `slot` registry — `summary | primary | secondary |
//      action`. These are the four dashboard regions W2 introduces;
//      the validator is the gate so the client never has to branch
//      on an unknown slot string.
//   4. Props size cap. A pathological producer shouldn't be able
//      to fill the DB with multi-MB widget blobs; reject early with
//      a generous cap (see `MAX_PROPS_JSON_BYTES`).
//   5. `widgetKey` is caller-chosen but validated here for shape —
//      non-empty, no whitespace-only, and capped at a sensible
//      length so it can't exceed Postgres index key limits.
//   6. P8 — kind-slot matching enforced via `SLOT_POLICY` from
//      `./slotPolicy`. A write that declares a kind+slot combination
//      the policy doesn't permit (say `contact_table` in
//      `secondary`) fails here, before the upsert runs and before
//      any sibling eviction logic kicks in. See slotPolicy.ts for
//      the full rationale.

import { SLOT_POLICY } from "./slotPolicy";

export const WIDGET_KINDS = [
  "campaign_list",
  "campaign_card",
  "contact_table",
  "activity_stream",
  "confirm_draft",
  "confirm_send",
  // W7 — server-owned rollup pinned to the `summary` slot. Unlike the
  // other six (which come from a tool's handler as a side-effect of a
  // model call), the rollup is computed by a standalone helper
  // (`refreshWorkspaceSummary`) invoked after workspace-mutating
  // actions. No tool emits this kind; keeping it in the closed registry
  // is how the validator accepts rollup writes while every OTHER
  // producer path for the same kind stays firmly rejected.
  "workspace_rollup",
  // P6 — file ingest surfaces. Both are widget-only (no directive twin):
  //   `file_digest`     — per-file summary card the assistant emits after
  //                       reading an ingested file. Upserts per-ingestId
  //                       so re-summarising replaces the prior card.
  //   `import_review`   — structured preview of a file the assistant
  //                       thinks is an importable list (contacts / invitees
  //                       / campaign metadata). The card renders the
  //                       detection + sample rows; the actual import
  //                       commit is gated behind P7's confirm flow, so
  //                       this kind is STRICTLY read-only in P6.
  "file_digest",
  "import_review",
  // P7 — action-slot confirmation for a structured import. The
  // operator sees the expected-writes counters, clicks confirm, and
  // the destructive `commit_import` tool runs on the server with
  // `allowDestructive: true`. Widget morphs through the same
  // `ready` | `blocked` | `submitting` | `done` | `error` state
  // machine that `confirm_send` uses; `done` carries the actual
  // create/skip/invalid counters.
  "confirm_import",
] as const;

export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const WIDGET_SLOTS = [
  "summary",
  "primary",
  "secondary",
  "action",
] as const;

export type WidgetSlot = (typeof WIDGET_SLOTS)[number];

// Generous upper bound on the serialised props size. A campaign
// card with ~50 activity rows lands around 15KB of JSON today; 100KB
// is ~6x headroom without letting a pathological tool write MBs of
// props. The cap is enforced on the stringified payload because that
// is what actually hits the DB column.
export const MAX_PROPS_JSON_BYTES = 100 * 1024;

// A widget key is caller-chosen; cap at 200 chars so the DB unique
// index (`@@unique([sessionId, widgetKey])`) stays well under
// Postgres's ~8KB btree key limit even when combined with cuid
// sessionIds, and so that UI labels / tooling never truncate in
// surprising ways.
export const MAX_WIDGET_KEY_LEN = 200;

export type WidgetInput = {
  widgetKey: string;
  kind: WidgetKind;
  slot: WidgetSlot;
  props: Record<string, unknown>;
  order?: number;
  sourceMessageId?: string | null;
};

// ---- generic primitive / shape helpers ----
// Duplicated from directive-validate.ts on purpose — see the
// "Design constraints" note at the top of this file for the
// independence rationale.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isFiniteInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isOneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
): v is T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

// Optional field helper: absent OR present and passes the predicate.
// Present-but-wrong-type fails — producers should omit optional
// fields, not pass junk.
function optional<T>(
  obj: Record<string, unknown>,
  key: string,
  pred: (v: unknown) => v is T,
): boolean {
  if (!(key in obj)) return true;
  const v = obj[key];
  if (v === undefined) return true;
  return pred(v);
}

const TONES = ["default", "success", "warn", "fail"] as const;
const VIP_TIERS = ["royal", "minister", "vip", "standard"] as const;
// P13-D.2 widening — confirm_send widgets now carry a WhatsApp
// channel value alongside email / sms. `"both"` is preserved as
// email + SMS only (pre-P13 invariant — legacy callers never meant
// to send WhatsApp); `"all"` is the explicit three-channel umbrella.
// Keeping the vocabulary aligned with `SendCampaignChannel` means
// a `propose_send` widget emit passes the validator gate without a
// second translation.
const CHANNELS = ["email", "sms", "whatsapp", "both", "all"] as const;

// W5 — persisted widget state for the action-slot widgets. The
// spec lists five states; their mapping to the UI is:
//   ready      — preview ready, button enabled (confirm_send only)
//   blocked    — preview has blockers, button disabled
//   submitting — transient mid-POST state (rarely persisted; the
//                confirm route writes terminal states after dispatch
//                completes, so `submitting` is mostly client-local)
//   done       — action completed successfully (carries `result`)
//   error      — action failed with a structured error (carries
//                `error`)
// `confirm_draft` is terminal-on-creation — the draft is written
// before the widget emits — so it only ever carries `state: "done"`.
// Keeping the same enum across both kinds means the renderer /
// reducer can dispatch on state without a per-kind branch.
export const CONFIRM_STATES = [
  "ready",
  "blocked",
  "submitting",
  "done",
  "error",
] as const;

export type ConfirmState = (typeof CONFIRM_STATES)[number];

// ---- per-kind prop validators ----
//
// The prop shapes MIRROR the corresponding directive validators —
// when W3 migrates tools from `emitDirective(...)` to
// `upsertWidget(...)`, the producers pass the exact same object into
// `props`. Keeping the shape checks in lockstep is a deliberate
// maintenance cost; the alternative (a shared module) tangles two
// trust boundaries together and blocks future divergence.

function validateCampaignList(p: Record<string, unknown>): boolean {
  if (!Array.isArray(p.items)) return false;
  for (const it of p.items) {
    if (!isPlainObject(it)) return false;
    if (!isNonEmptyString(it.id)) return false;
    if (!isString(it.name)) return false;
    if (!isString(it.status)) return false;
    if (!isStringOrNull(it.event_at)) return false;
    if (!isStringOrNull(it.venue)) return false;
    if (!isStringOrNull(it.team_id)) return false;
    if (!isPlainObject(it.stats)) return false;
    if (!isFiniteNumber(it.stats.total)) return false;
    if (!isFiniteNumber(it.stats.responded)) return false;
    if (!isFiniteNumber(it.stats.headcount)) return false;
  }
  if ("filters" in p && p.filters !== undefined) {
    if (!isPlainObject(p.filters)) return false;
    const f = p.filters;
    if (!optional(f, "status", isStringArray)) return false;
    if (!optional(f, "upcoming_only", isBoolean)) return false;
    if (!optional(f, "limit", isFiniteNumber)) return false;
  }
  return true;
}

function validateCampaignCard(p: Record<string, unknown>): boolean {
  if (!isNonEmptyString(p.id)) return false;
  if (!isString(p.name)) return false;
  if (!isStringOrNull(p.description)) return false;
  if (!isString(p.status)) return false;
  if (!isStringOrNull(p.event_at)) return false;
  if (!isStringOrNull(p.venue)) return false;
  if (!isStringOrNull(p.locale)) return false;
  if (!isStringOrNull(p.team_id)) return false;
  if (!isString(p.created_at)) return false;
  if (!isString(p.updated_at)) return false;
  if (!isPlainObject(p.stats)) return false;
  // P13-D.3 — `sentWhatsApp` joined the required set. See the twin
  // comment in `directive-validate.ts` for the rationale (fail-closed
  // on pre-P13 blobs so a missing field can't silently render "0w").
  for (const k of [
    "total",
    "responded",
    "pending",
    "attending",
    "declined",
    "guests",
    "headcount",
    "sentEmail",
    "sentSms",
    "sentWhatsApp",
  ]) {
    if (!isFiniteNumber(p.stats[k])) return false;
  }
  if (!Array.isArray(p.activity)) return false;
  for (const a of p.activity) {
    if (!isPlainObject(a)) return false;
    if (!isNonEmptyString(a.id)) return false;
    if (!isString(a.created_at)) return false;
    if (!isString(a.kind)) return false;
    if (!isOneOf(a.tone, TONES)) return false;
    if (!isString(a.line)) return false;
  }
  if (!optional(p, "invitee_scan_capped", isBoolean)) return false;
  return true;
}

function validateContactTable(p: Record<string, unknown>): boolean {
  if (!Array.isArray(p.items)) return false;
  for (const it of p.items) {
    if (!isPlainObject(it)) return false;
    if (!isNonEmptyString(it.id)) return false;
    if (!isString(it.full_name)) return false;
    if (!isStringOrNull(it.title)) return false;
    if (!isStringOrNull(it.organization)) return false;
    if (!isStringOrNull(it.email)) return false;
    if (!isStringOrNull(it.phone_e164)) return false;
    if (!isOneOf(it.vip_tier, VIP_TIERS)) return false;
    if (!isString(it.vip_label)) return false;
    if (!isStringOrNull(it.tags)) return false;
    if (!isStringOrNull(it.archived_at)) return false;
    if (!isFiniteNumber(it.invitee_count)) return false;
  }
  if (!isFiniteNumber(p.total)) return false;
  if ("filters" in p && p.filters !== undefined) {
    if (!isPlainObject(p.filters)) return false;
    const f = p.filters;
    if (!isStringOrNull(f.query)) return false;
    if (!isString(f.tier)) return false;
    if (!isBoolean(f.include_archived)) return false;
    if (!isFiniteNumber(f.limit)) return false;
  }
  return true;
}

function validateActivityStream(p: Record<string, unknown>): boolean {
  if (!Array.isArray(p.items)) return false;
  for (const it of p.items) {
    if (!isPlainObject(it)) return false;
    if (!isNonEmptyString(it.id)) return false;
    if (!isString(it.created_at)) return false;
    if (!isString(it.kind)) return false;
    if (!isStringOrNull(it.ref_type)) return false;
    if (!isStringOrNull(it.ref_id)) return false;
    if (!isOneOf(it.tone, TONES)) return false;
    if (!isString(it.line)) return false;
    if (it.actor !== null) {
      if (!isPlainObject(it.actor)) return false;
      if (!isString(it.actor.email)) return false;
      if (!isStringOrNull(it.actor.full_name)) return false;
    }
  }
  if ("filters" in p && p.filters !== undefined) {
    if (!isPlainObject(p.filters)) return false;
    const f = p.filters;
    if (!isFiniteNumber(f.days)) return false;
    if (!isFiniteNumber(f.limit)) return false;
  }
  return true;
}

function validateConfirmDraft(p: Record<string, unknown>): boolean {
  if (!isNonEmptyString(p.id)) return false;
  if (!isString(p.name)) return false;
  if (!isStringOrNull(p.description)) return false;
  if (!isStringOrNull(p.venue)) return false;
  if (!isStringOrNull(p.event_at)) return false;
  if (!isString(p.locale)) return false;
  if (!isString(p.status)) return false;
  if (!isStringOrNull(p.team_id)) return false;
  if (!isString(p.created_at)) return false;
  if (!optional(p, "event_at_ignored", isBoolean)) return false;
  // W5 — state is terminal-on-creation for drafts. The row exists
  // before the widget emits, so the only value the validator ever
  // sees is "done". Reject any other value rather than allow
  // surprise transitions — a draft has no POST flow.
  if (p.state !== "done") return false;
  return true;
}

function validateChannelBreakdown(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  if (!isFiniteNumber(v.ready)) return false;
  if (!isFiniteNumber(v.skipped_already_sent)) return false;
  if (!isFiniteNumber(v.skipped_unsubscribed)) return false;
  if (!isFiniteNumber(v.no_contact)) return false;
  return true;
}

// W5 — shape of the server-reported send outcome persisted on the
// confirm_send widget after dispatch. Mirrors the audit counters in
// `runConfirmSend`: email/sms/whatsapp = successful deliveries per
// channel, skipped = rows the router intentionally bypassed
// (already-sent / unsubscribed / no-contact), failed = provider
// errors that hit the retry queue. `whatsapp` is an additive field
// (P13-D.2) — a legacy two-channel send still passes the gate with
// whatsapp=0. Required (not optional) because the outcome writer
// in `confirm-flow.ts:242-251` ALWAYS populates it now, so a blob
// missing `whatsapp` is evidence of schema drift between the writer
// and the validator.
function validateConfirmSendResult(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  if (!isFiniteNumber(v.email)) return false;
  if (!isFiniteNumber(v.sms)) return false;
  if (!isFiniteNumber(v.whatsapp)) return false;
  if (!isFiniteNumber(v.skipped)) return false;
  if (!isFiniteNumber(v.failed)) return false;
  return true;
}

// P13-D.2 — WhatsApp template identity for the ConfirmSend preview.
// Meta identifies an approved template by the (name, language) pair,
// and the actual template body lives on Meta's side — our Campaign
// row only stores the identity. When WA is configured the preview
// shows the identity so the operator can sanity-check they picked
// the right template. Null when either field is missing (matches
// the `no_whatsapp_template` blocker predicate).
function validateWhatsAppTemplateLabel(v: unknown): boolean {
  if (v === null) return true;
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.name)) return false;
  if (!isNonEmptyString(v.language)) return false;
  return true;
}

function validateConfirmSend(p: Record<string, unknown>): boolean {
  if (!isNonEmptyString(p.campaign_id)) return false;
  if (!isString(p.name)) return false;
  if (!isString(p.status)) return false;
  if (!isStringOrNull(p.venue)) return false;
  if (!isStringOrNull(p.event_at)) return false;
  if (!isString(p.locale)) return false;
  if (!isOneOf(p.channel, CHANNELS)) return false;
  if (!isBoolean(p.only_unsent)) return false;
  if (!isFiniteNumber(p.invitee_total)) return false;
  if (!isFiniteNumber(p.ready_messages)) return false;
  if (!isPlainObject(p.by_channel)) return false;
  if (!validateChannelBreakdown(p.by_channel.email)) return false;
  if (!validateChannelBreakdown(p.by_channel.sms)) return false;
  // P13-D.2 — WhatsApp bucket uses the same breakdown shape as
  // email/sms. Required (not optional) so a widget blob missing the
  // bucket is treated as drift rather than silently defaulted to
  // zeros. Scalar-email sends still populate this bucket with all
  // zeros; the card's renderer only shows the row when the value
  // is non-zero or the channel set includes WhatsApp.
  if (!validateChannelBreakdown(p.by_channel.whatsapp)) return false;
  if (!isPlainObject(p.template_preview)) return false;
  if (!isStringOrNull(p.template_preview.subject_email)) return false;
  if (!isStringOrNull(p.template_preview.email_body)) return false;
  if (!isStringOrNull(p.template_preview.sms_body)) return false;
  // P13-D.2 — WhatsApp template identity. Shape: `{name, language} | null`.
  // See `validateWhatsAppTemplateLabel` for the predicate rationale.
  if (!validateWhatsAppTemplateLabel(p.template_preview.whatsapp_template)) {
    return false;
  }
  if (!isStringArray(p.blockers)) return false;
  // W5 — state drives the renderer. See the `CONFIRM_STATES` comment
  // block above for the full state machine.
  if (!isOneOf(p.state, CONFIRM_STATES)) return false;
  // `ready` / `blocked` / `submitting` are pre-terminal — no result,
  // no error on the blob. The renderer reads state and short-circuits.
  // `done` and `error` are TERMINAL states that carry their outcome
  // payload; the route writes exactly one of them after dispatch.
  if (p.state === "done") {
    if (!validateConfirmSendResult(p.result)) return false;
    // Error must be absent on a successful dispatch — a blob with
    // both `result` and `error` is inconsistent and rejected rather
    // than letting the renderer guess which one wins.
    if ("error" in p && p.error !== undefined) return false;
  } else if (p.state === "error") {
    if (!isNonEmptyString(p.error)) return false;
    if ("result" in p && p.result !== undefined) return false;
  } else {
    // Pre-terminal: no outcome fields allowed. Keeps the blob small
    // on the common case (a preview that's never actioned).
    if ("result" in p && p.result !== undefined) return false;
    if ("error" in p && p.error !== undefined) return false;
  }
  // Optional one-line summary. The route can set this for any
  // terminal state to give the transcript a tidy recap ("Sent 42 via
  // email, 3 skipped."); the renderer falls back to a derived summary
  // when absent.
  if (!optional(p, "summary", isString)) return false;
  return true;
}

// W7 — workspace_rollup prop shape. A small, flat blob of integer
// counters scoped to the operator's visible campaigns. The rollup
// exists to give the dashboard a single "at-a-glance" card; its
// producers are server-owned (not model-driven), so the validator is
// primarily a drift guard for read-side `rowToWidget` rehydration
// rather than a defence against a misbehaving tool.
//
// Why every counter is required (no optional `|| 0` in the renderer):
//   - The compute helper writes ALL fields on every refresh. A missing
//     field here would mean schema drift between the helper and the
//     validator, which is exactly the case `validateWidgetProps`
//     catches on read to fail closed.
//   - `generated_at` is an ISO timestamp so the renderer can show
//     relative freshness ("updated 2 min ago") without a second trip
//     to `updatedAt` from the DB.
function validateWorkspaceRollup(p: Record<string, unknown>): boolean {
  if (!isPlainObject(p.campaigns)) return false;
  for (const k of ["draft", "active", "closed", "archived", "total"]) {
    if (!isFiniteInteger(p.campaigns[k])) return false;
  }
  if (!isPlainObject(p.invitees)) return false;
  if (!isFiniteInteger(p.invitees.total)) return false;
  if (!isPlainObject(p.responses)) return false;
  for (const k of ["total", "attending", "declined", "recent_24h"]) {
    if (!isFiniteInteger(p.responses[k])) return false;
  }
  if (!isPlainObject(p.invitations)) return false;
  if (!isFiniteInteger(p.invitations.sent_24h)) return false;
  if (!isNonEmptyString(p.generated_at)) return false;
  return true;
}

// P6 — `file_digest` prop shape.
//
// Emitted by `summarize_file` after the assistant has read an ingested
// file. The card is per-ingest (upserts on a key derived from ingestId)
// so re-summarising the same file replaces its card in place.
//
// Trace-back: `fileUploadId` + `ingestId` are REQUIRED on every row.
// P6 constraint: "every extracted fact shown in widgets must trace back
// to the file/job". The renderer uses `fileUploadId` to link back to
// the raw upload (P7+ may add a "download original" action).
//
// `preview` carries a bounded prefix of the extracted text (capped at
// the tool-handler boundary, not here — validator accepts any string
// that fits within MAX_PROPS_JSON_BYTES). Null when extraction failed
// or kind=unsupported. The card renders `preview` as a short excerpt
// WITH a visible marker that it's truncated; the full text is never
// piped into the composer.
const FILE_DIGEST_KINDS = [
  "text_plain",
  "pdf",
  "docx",
  "unsupported",
  "failed",
] as const;

const FILE_DIGEST_STATUSES = ["extracted", "failed", "unsupported"] as const;

function validateFileDigest(p: Record<string, unknown>): boolean {
  if (!isNonEmptyString(p.fileUploadId)) return false;
  if (!isNonEmptyString(p.ingestId)) return false;
  if (!isNonEmptyString(p.filename)) return false;
  if (!isOneOf(p.kind, FILE_DIGEST_KINDS)) return false;
  if (!isOneOf(p.status, FILE_DIGEST_STATUSES)) return false;
  if (!isFiniteInteger(p.bytesExtracted)) return false;
  if (p.bytesExtracted < 0) return false;
  if (!isStringOrNull(p.preview)) return false;
  if (p.charCount !== null && !isFiniteInteger(p.charCount)) return false;
  if (p.lineCount !== null && !isFiniteInteger(p.lineCount)) return false;
  if (!isNonEmptyString(p.extractedAt)) return false;
  if (!isStringOrNull(p.extractionError)) return false;
  if (!optional(p, "previewTruncated", isBoolean)) return false;
  return true;
}

// P6 — `import_review` prop shape.
//
// Emitted by `review_file_import` when the ingested file parses as a
// recognisable importable list. P6 scope: read-only preview of what
// would be imported, rendered so the operator can spot obvious issues
// before the P7 commit flow lands.
//
// `target` is one of three recognised import destinations. Adding a
// new destination requires a validator tweak + a renderer case + a
// detector case in `src/lib/ingest/review.ts`.
//
// `totals` carries the full-file counters; `sample` is the first N
// rows the detector examined (bounded in the tool handler so the prop
// blob stays well under MAX_PROPS_JSON_BYTES even for large files).
//
// `rowStatus` on each sample row:
//   "new"              — no match in the target collection today
//   "existing_match"   — exact match found (email / phone / id)
//   "conflict"         — match found but fields disagree
//   "unknown"          — detector didn't try to match (P6 default for
//                        non-contacts targets)
const IMPORT_TARGETS = ["contacts", "invitees", "campaign_metadata"] as const;
const IMPORT_ROW_STATUSES = [
  "new",
  "existing_match",
  "conflict",
  "unknown",
] as const;

function validateImportReviewSampleRow(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  if (!isPlainObject(v.fields)) return false;
  for (const k of Object.keys(v.fields)) {
    if (typeof v.fields[k] !== "string") return false;
  }
  if (!isOneOf(v.rowStatus, IMPORT_ROW_STATUSES)) return false;
  if ("matchId" in v && v.matchId !== undefined) {
    if (!isStringOrNull(v.matchId)) return false;
  }
  if ("issues" in v && v.issues !== undefined) {
    if (!isStringArray(v.issues)) return false;
  }
  return true;
}

function validateImportReview(p: Record<string, unknown>): boolean {
  if (!isNonEmptyString(p.fileUploadId)) return false;
  if (!isNonEmptyString(p.ingestId)) return false;
  if (!isNonEmptyString(p.filename)) return false;
  if (!isOneOf(p.target, IMPORT_TARGETS)) return false;
  if (!isStringArray(p.columns)) return false;
  if (!Array.isArray(p.sample)) return false;
  for (const row of p.sample) {
    if (!validateImportReviewSampleRow(row)) return false;
  }
  if (!isPlainObject(p.totals)) return false;
  for (const k of [
    "rows",
    "sampled",
    "new",
    "existing_match",
    "conflict",
    "with_issues",
  ]) {
    if (!isFiniteInteger(p.totals[k])) return false;
    if ((p.totals[k] as number) < 0) return false;
  }
  if (!isNonEmptyString(p.detectedAt)) return false;
  if (!isStringArray(p.notes)) return false;
  return true;
}

// P7 — `confirm_import` prop shape.
//
// Emitted by `propose_import` after it re-reviews an ingested file and
// decides what a commit would do. The widget sits in the `action`
// slot of the workspace dashboard and morphs through the same state
// machine `confirm_send` uses (`ready` / `blocked` / `submitting` /
// `done` / `error`). The destructive write itself is the
// `commit_import` tool, which the confirm route dispatches with
// `allowDestructive: true` after atomically claiming the anchor.
//
// Two target modes are currently supported:
//   - "contacts"  — writes to the global Contact table, no campaign
//                   required.
//   - "invitees"  — writes to Campaign.invitees for a specific
//                   campaign_id; that id is required on the props.
//
// `campaign_metadata` is read-only in P7 (preview only — see
// `import_review`) because a metadata commit would be a mutation
// against a Campaign row, which is already handled by the
// `draft_campaign` tool and doesn't belong in the import flow.
//
// `expected` mirrors the shape of what `propose_import` computed over
// the review sample — "if you click confirm, these are the row
// counters you'll see". `result` on `done` reports what commit_import
// ACTUALLY did; shapes are intentionally close but not identical
// (commit can surface `duplicatesInFile` / `errors` that the preview
// pass cannot know about).
const IMPORT_COMMIT_TARGETS = ["contacts", "invitees"] as const;

function validateImportExpected(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  for (const k of ["newRows", "existingSkipped", "conflicts", "invalid"]) {
    if (!isFiniteInteger(v[k])) return false;
    if ((v[k] as number) < 0) return false;
  }
  return true;
}

function validateImportResult(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  for (const k of [
    "created",
    "existingSkipped",
    "duplicatesInFile",
    "invalid",
    "errors",
  ]) {
    if (!isFiniteInteger(v[k])) return false;
    if ((v[k] as number) < 0) return false;
  }
  return true;
}

function validateConfirmImport(p: Record<string, unknown>): boolean {
  if (!isNonEmptyString(p.fileUploadId)) return false;
  if (!isNonEmptyString(p.ingestId)) return false;
  if (!isNonEmptyString(p.filename)) return false;
  if (!isOneOf(p.target, IMPORT_COMMIT_TARGETS)) return false;
  // campaign_id is required when target is "invitees" (an invitee row
  // must belong to some campaign) and null otherwise (contacts are
  // global). Reject the crossed-wires combinations rather than
  // letting the commit handler discover them mid-write.
  if (p.target === "invitees") {
    if (!isNonEmptyString(p.campaign_id)) return false;
  } else {
    if (p.campaign_id !== null) return false;
  }
  if (!isStringArray(p.columns)) return false;
  if (!isFiniteInteger(p.sampledRows)) return false;
  if ((p.sampledRows as number) < 0) return false;
  if (!isFiniteInteger(p.totalRows)) return false;
  if ((p.totalRows as number) < 0) return false;
  if (!validateImportExpected(p.expected)) return false;
  if (!isStringArray(p.blockers)) return false;
  if (!isOneOf(p.state, CONFIRM_STATES)) return false;
  if (p.state === "done") {
    if (!validateImportResult(p.result)) return false;
    if ("error" in p && p.error !== undefined) return false;
  } else if (p.state === "error") {
    if (!isNonEmptyString(p.error)) return false;
    if ("result" in p && p.result !== undefined) return false;
  } else {
    if ("result" in p && p.result !== undefined) return false;
    if ("error" in p && p.error !== undefined) return false;
  }
  if (!optional(p, "summary", isString)) return false;
  return true;
}

// Kind -> prop-shape validator. Extending this requires: (1) add to
// WIDGET_KINDS, (2) add validator here, (3) add renderer in the
// workspace dashboard registry. Skipping any one of the three should
// fail review.
const PROP_VALIDATORS: Record<WidgetKind, (p: Record<string, unknown>) => boolean> =
  {
    campaign_list: validateCampaignList,
    campaign_card: validateCampaignCard,
    contact_table: validateContactTable,
    activity_stream: validateActivityStream,
    confirm_draft: validateConfirmDraft,
    confirm_send: validateConfirmSend,
    workspace_rollup: validateWorkspaceRollup,
    file_digest: validateFileDigest,
    import_review: validateImportReview,
    confirm_import: validateConfirmImport,
  };

// ---- public entry point ----
//
// Returns the canonical input on pass, or null on any failure.
// Identity-preserving for `props` on success — same object reference
// goes out as came in (we just re-typed it), no cloning, no
// sanitisation. "Validate, don't rewrite."
//
// Shape expected by callers (upsertWidget + the chat route's
// workspace emit path):
//   { widgetKey, kind, slot, props, order?, sourceMessageId? }
//
// The caller supplies `sessionId` separately — it's not part of the
// validated payload because it comes from the authenticated chat
// session, not the tool / model.
export function validateWidget(input: unknown): WidgetInput | null {
  if (!isPlainObject(input)) return null;

  const widgetKey = input.widgetKey;
  if (!isNonEmptyString(widgetKey)) return null;
  if (widgetKey.length > MAX_WIDGET_KEY_LEN) return null;
  // Whitespace-only keys would pass isNonEmptyString but are
  // indistinguishable from empty in UI / log lines — reject here so
  // a buggy caller can't silently write unaddressable widgets.
  if (widgetKey.trim().length === 0) return null;

  const kind = input.kind;
  if (!isOneOf(kind, WIDGET_KINDS)) return null;

  const slot = input.slot;
  if (!isOneOf(slot, WIDGET_SLOTS)) return null;

  // P8 — kind-slot policy gate. A kind has exactly one legal slot;
  // see `SLOT_POLICY` in ./slotPolicy for the full mapping. Reject a
  // crossed-wires combination here so the eviction logic downstream
  // never has to consider "did this widget arrive in the wrong slot?".
  if (SLOT_POLICY[kind] !== slot) return null;

  const props = input.props;
  if (!isPlainObject(props)) return null;

  // Size cap. Stringify ONCE here and discard; callers who need a
  // serialised payload for persistence call JSON.stringify(props)
  // again. The double-serialise cost is negligible next to the DB
  // write and keeps this function side-effect free (returning
  // `{props, propsJson}` would couple the validator to the
  // persistence layer's serialisation choice).
  let serialised: string;
  try {
    serialised = JSON.stringify(props);
  } catch {
    // JSON.stringify throws on cycles; a cyclic props object is a
    // programming bug, not a valid widget.
    return null;
  }
  // Byte length via Buffer to match what Postgres actually stores
  // (UTF-8). Falling back to string length would under-count for
  // any multi-byte char (Arabic display names, VIP labels, etc.).
  if (Buffer.byteLength(serialised, "utf8") > MAX_PROPS_JSON_BYTES) {
    return null;
  }

  if (!PROP_VALIDATORS[kind](props)) return null;

  const out: WidgetInput = { widgetKey, kind, slot, props };

  if ("order" in input && input.order !== undefined) {
    if (!isFiniteInteger(input.order)) return null;
    out.order = input.order;
  }

  if ("sourceMessageId" in input && input.sourceMessageId !== undefined) {
    if (!isStringOrNull(input.sourceMessageId)) return null;
    // Empty string would trip Prisma's FK lookup with a confusing
    // "record not found" — normalise to null at the boundary.
    out.sourceMessageId =
      input.sourceMessageId === "" ? null : input.sourceMessageId;
  }

  return out;
}

// Narrow helper for the DB-read path in `widgets.ts`. When loading
// widgets out of the table, the envelope (kind, slot, widgetKey) is
// already a trusted value that passed `validateWidget` on the way
// in. What we want to re-check on read is ONLY whether the parsed
// `props` JSON still matches the current shape for the declared
// kind — a defence against schema drift between write and read
// (rare, but the validator layer is the only thing standing between
// a stale blob and a `props as XProps` cast in the renderer).
//
// Returns true iff `kind` is a known widget kind and `props` passes
// that kind's prop-shape check. No envelope / slot / size / order
// checks — those are the caller's responsibility when rebuilding
// the full envelope (and they all come from trusted DB columns).
export function validateWidgetProps(
  kind: string,
  props: unknown,
): props is Record<string, unknown> {
  if (!isOneOf(kind, WIDGET_KINDS)) return false;
  if (!isPlainObject(props)) return false;
  return PROP_VALIDATORS[kind](props);
}

// W7 — gate for the operator-dismissable action widgets. Dismiss is
// ONLY offered on terminal confirm surfaces (operator has seen the
// outcome and is clearing the row) and ONLY on the two confirm
// kinds — every other widget kind is a live view that the operator
// shouldn't be able to accidentally close from chat.
//
// Server-side the dismiss route calls this after `rowToWidget`
// rehydrates the stored props, so the shape we see here has already
// passed `validateWidgetProps`. Client-side `WidgetRenderer` calls
// it on a `ClientWidget` whose props traversed the same validation
// on the SSE emit path. Sharing this gate means a widget that
// SHOWS the dismiss affordance is exactly the widget the server
// will agree to delete — no "button renders but POST returns 400"
// surprises when the UI drifts from the server contract.
export function isTerminalConfirmWidget(
  kind: string,
  props: unknown,
): boolean {
  if (!isPlainObject(props)) return false;
  if (kind === "confirm_draft") {
    // Draft widgets are terminal-on-creation — the row is written
    // before the widget emits and no post-action flow exists. The
    // validator only accepts `state === "done"` for this kind, so
    // this line is belt-and-braces against a drifted blob.
    return props.state === "done";
  }
  if (kind === "confirm_send") {
    // Send widgets are dismissable only AFTER the destructive POST
    // landed a terminal state. `ready` / `blocked` / `submitting`
    // are pre-action — dismissing those would throw away an unused
    // authorization anchor and confuse the operator.
    return props.state === "done" || props.state === "error";
  }
  if (kind === "confirm_import") {
    // P7 — same post-commit policy as confirm_send. Pre-terminal
    // dismiss would throw away the single-use anchor before the
    // operator ever actioned it.
    return props.state === "done" || props.state === "error";
  }
  return false;
}
