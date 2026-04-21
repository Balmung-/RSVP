// Server-side validate-per-kind for render directives.
//
// The ORIGINAL state of the chat surface had a comment in
// `DirectiveRenderer.tsx` explicitly flagging this as a TODO:
// "directives written to DB are currently validated only by the
// handler that produced them." That's a trust-the-handler model,
// which is fine until:
//   - a tool refactor silently drops a required field and the
//     bug sits in the DB for a week before someone notices a
//     blank card,
//   - a future replay path (load-history) deserializes stored
//     JSON into props and hands it to a renderer that casts with
//     `as unknown as XProps` (see DirectiveRenderer's boundary
//     cast), which gives TypeScript zero say at runtime,
//   - a test or a harness injects a malformed directive and we'd
//     rather reject at the persistence boundary than have it
//     reach the client.
//
// This module closes the loop. It's called from
// `src/app/api/chat/route.ts` at the moment the handler's
// `result.directive` is picked up. A null return means "the shape
// is not what the registered renderer accepts" — the chat route
// drops the directive (no DB row-column written, no SSE emit) and
// the assistant's text still carries the answer. The decision is
// deliberately STRICT: we'd rather lose a broken card than ship a
// half-drawn one.
//
// Design constraints:
//   1. Pure function, no I/O, no imports beyond types. Unit-tested
//      in `tests/unit/directive-validate.test.ts` with fake
//      payloads; no DB, no Anthropic.
//   2. Per-kind shape-match mirrors the producer tool's `directive.props`
//      (see `list_campaigns.ts:179-189`, `campaign_detail.ts:206-209`,
//      `search_contacts.ts:144-157`, `recent_activity.ts:149-153`,
//      `draft_campaign.ts:212-227`, `propose_send.ts:266-291`) AND
//      the consumer renderer's Props type (see files in
//      `src/components/chat/directives/`). Those two agree by
//      construction today; this validator pins the contract.
//   3. The kind set is CLOSED — same registry the renderer uses.
//      An unknown kind returns null, matching the renderer's
//      silent-drop on the client side but closing the gap on the
//      server: we don't even persist the unknown kind.
//   4. Required fields fail closed. Optional fields (documented
//      with `?` in the Props types) must either be absent or
//      match the expected type; a present-but-wrong-type optional
//      still rejects the whole directive because it's evidence
//      the producer is confused.

export type RenderDirective = {
  kind: string;
  props: Record<string, unknown>;
};

// ---- generic primitive / shape helpers ----

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

// Optional field helper: returns true when key is absent OR present
// and passes the predicate. A present-but-wrong-type value fails —
// producers should omit optional fields, not pass junk.
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
// P13-D.2 widening — directive confirm_send now carries the widened
// channel vocabulary. Kept in sync with `widget-validate.ts` by
// convention (the two files are independent gates so future
// divergence stays possible; for now both need the same values).
const CHANNELS = ["email", "sms", "whatsapp", "both", "all"] as const;

// ---- per-kind validators ----
//
// Each returns true iff `props` matches the shape the corresponding
// renderer reads. Required fields are strict (must be present AND of
// the right type); optional fields use `optional(...)` which allows
// absence but rejects wrong-type-if-present.

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
  // Every numeric field the renderer reads out of `stats` — a miss
  // here paints zeros silently, which is exactly the kind of "bug
  // that looks like truth" this module is supposed to prevent.
  // P13-D.3 — `sentWhatsApp` joined the required set. Pre-P13 blobs
  // don't carry the field and are intentionally rejected rather than
  // rehydrated with a silent zero default; that keeps the renderer's
  // "0w" row honest (real zero, not "field missing pretending to be
  // zero") and mirrors the `by_channel.whatsapp` gate on confirm_send.
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
    // `actor` is `{email, full_name: string|null} | null`. The
    // renderer doesn't actually read `actor` today, but the tool
    // emits it and future renderer changes will. Validating now
    // keeps the contract stable.
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

// P13-D.2 — mirrors `validateWhatsAppTemplateLabel` in
// widget-validate.ts. See the sibling file for the rationale; kept
// local to this module per the "independent validators" constraint
// documented at the top of this file.
function validateWhatsAppTemplateLabel(v: unknown): boolean {
  if (v === null) return true;
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.name)) return false;
  if (!isNonEmptyString(v.language)) return false;
  return true;
}

// P17-C.5 — mirrors `validateWhatsAppDocumentLabel` in
// widget-validate.ts. The directive + widget validators are kept
// structurally identical but not shared (see the file-top
// "independent validators" constraint); extending one without the
// other is the kind of drift these mirrored tests catch on review.
function validateWhatsAppDocumentLabel(v: unknown): boolean {
  if (v === null) return true;
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.filename)) return false;
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
  // P13-D.2 — WhatsApp bucket has the same shape as email/sms;
  // required so a directive payload missing the field is treated
  // as drift and rejected before render.
  if (!validateChannelBreakdown(p.by_channel.whatsapp)) return false;
  if (!isPlainObject(p.template_preview)) return false;
  if (!isStringOrNull(p.template_preview.subject_email)) return false;
  if (!isStringOrNull(p.template_preview.email_body)) return false;
  if (!isStringOrNull(p.template_preview.sms_body)) return false;
  // P13-D.2 — WhatsApp template identity. Null when not configured.
  if (!validateWhatsAppTemplateLabel(p.template_preview.whatsapp_template)) {
    return false;
  }
  // P17-C.5 — WhatsApp PDF readiness label. Null when the campaign
  // doesn't use the doc-header path OR the FileUpload is missing.
  // Required on every directive payload so pre-C.5 rehydrations fail
  // closed rather than silently rendering a card without the
  // attachment row.
  if (!validateWhatsAppDocumentLabel(p.template_preview.whatsapp_document)) {
    return false;
  }
  if (!isStringArray(p.blockers)) return false;
  return true;
}

// Kind -> validator. Extending this with a new directive is a four-
// step change (tool handler, renderer Props, registry switch,
// validator entry); skipping any one of them should fail a review.
const VALIDATORS: Record<string, (p: Record<string, unknown>) => boolean> = {
  campaign_list: validateCampaignList,
  campaign_card: validateCampaignCard,
  contact_table: validateContactTable,
  activity_stream: validateActivityStream,
  confirm_draft: validateConfirmDraft,
  confirm_send: validateConfirmSend,
};

// Public entry point. Returns the directive cast to the stable
// `{kind, props}` shape on pass, or null on any failure (bad
// envelope, unknown kind, shape mismatch). Identity-preserving:
// on success, we return the same `props` object the caller passed
// in — no cloning, no sanitisation. That keeps the contract
// "validate, don't rewrite".
export function validateDirective(input: unknown): RenderDirective | null {
  if (!isPlainObject(input)) return null;
  const kind = input.kind;
  const props = input.props;
  if (!isString(kind)) return null;
  if (!isPlainObject(props)) return null;
  const validator = VALIDATORS[kind];
  if (!validator) return null;
  if (!validator(props)) return null;
  return { kind, props };
}
