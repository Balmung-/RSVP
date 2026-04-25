import { prisma } from "./db";
import { getEmailProvider, getSmsProvider, getWhatsAppProvider } from "./providers";
import { renderEmail, renderSms, buildVars } from "./preview";
import { isUnsubscribed, unsubscribeUrl } from "./inbound";
import { decideWhatsAppMessage } from "./providers/whatsapp/sendPlan";
import { taqnyatUploadMedia } from "./providers/whatsapp/taqnyat";
import { isPdfUploadContentType } from "./uploads";
import type { Campaign, Invitee } from "@prisma/client";

// Orchestrates the outbound. Pure function of (campaign, invitee) → delivery.
// Rendering lives in preview.ts so test-send and the preview UI share exactly
// the same output as the real send.

const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";
const INBOUND_DOMAIN = () => process.env.INBOUND_EMAIL_DOMAIN ?? null;

// Per-invitee Reply-To. When INBOUND_EMAIL_DOMAIN is set, a reply to the
// invitation lands at rsvp+<token>@<inbound-domain> and is parsed by our
// inbound webhook.
function replyToFor(invitee: Invitee): string | undefined {
  const d = INBOUND_DOMAIN();
  if (!d) return undefined;
  return `rsvp+${invitee.rsvpToken}@${d}`;
}

// RFC 2369 / 8058 style List-Unsubscribe headers. Gmail and similar
// clients POST to this URL with `List-Unsubscribe=One-Click` when the
// user clicks the sender-strip unsubscribe button. Older MUAs just GET
// it; we redirect those to the public confirmation page. Clients that
// still send a mailto hit our inbound parser.
function listUnsubscribeHeaders(invitee: Invitee): Record<string, string> {
  const httpUrl = `${APP_URL().replace(/\/$/, "")}/api/unsubscribe/${invitee.rsvpToken}`;
  const d = INBOUND_DOMAIN();
  const mailto = d ? `mailto:unsubscribe+${invitee.rsvpToken}@${d}?subject=unsubscribe` : null;
  const value = [mailto ? `<${mailto}>` : null, `<${httpUrl}>`].filter(Boolean).join(", ");
  return {
    "List-Unsubscribe": value,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export async function sendEmail(campaign: Campaign, invitee: Invitee) {
  if (!invitee.email) return { ok: false as const, error: "no_email" };
  if (await isUnsubscribed({ email: invitee.email })) {
    return { ok: false as const, error: "unsubscribed" };
  }
  const { subject, text, html } = renderEmail(campaign, invitee);

  const inv = await prisma.invitation.create({
    data: { campaignId: campaign.id, inviteeId: invitee.id, channel: "email", status: "queued", payload: text },
  });

  const res = await getEmailProvider().send({
    to: invitee.email,
    subject,
    html,
    text,
    replyTo: replyToFor(invitee),
    headers: listUnsubscribeHeaders(invitee),
    // B3: per-campaign mailbox routing. The Gmail adapter picks the
    // OAuthAccount row for (provider=google, teamId=<campaign.teamId>),
    // falling back to the office-wide (teamId=null) slot if no team
    // mailbox is connected. Non-Gmail providers ignore this field.
    // For office-wide campaigns (campaign.teamId === null) this is
    // equivalent to omitting the field.
    teamId: campaign.teamId,
  });
  if (res.ok) {
    await prisma.invitation.update({
      where: { id: inv.id },
      data: { status: "sent", providerId: res.providerId, sentAt: new Date() },
    });
    await prisma.eventLog.create({
      data: { kind: "invite.sent", refType: "invitation", refId: inv.id, data: JSON.stringify({ channel: "email" }) },
    });
    return { ok: true as const, invitationId: inv.id };
  }
  await prisma.invitation.update({ where: { id: inv.id }, data: { status: "failed", error: res.error } });
  await prisma.eventLog.create({
    data: {
      kind: "invite.failed",
      refType: "invitation",
      refId: inv.id,
      data: JSON.stringify({ channel: "email", error: res.error }),
    },
  });
  return { ok: false as const, error: res.error };
}

export async function sendSms(campaign: Campaign, invitee: Invitee) {
  if (!invitee.phoneE164) return { ok: false as const, error: "no_phone" };
  if (await isUnsubscribed({ phone: invitee.phoneE164 })) {
    return { ok: false as const, error: "unsubscribed" };
  }
  const { body } = renderSms(campaign, invitee);

  const inv = await prisma.invitation.create({
    data: { campaignId: campaign.id, inviteeId: invitee.id, channel: "sms", status: "queued", payload: body },
  });

  // Append a short "Reply STOP" hint in English/Arabic if the body doesn't
  // already include one. Required for deliverability best practice.
  const bodyWithFooter = needsFooter(body) ? `${body}\nReply STOP to unsubscribe.` : body;

  const res = await getSmsProvider().send({ to: invitee.phoneE164, body: bodyWithFooter });
  if (res.ok) {
    await prisma.invitation.update({
      where: { id: inv.id },
      data: { status: "sent", providerId: res.providerId, sentAt: new Date() },
    });
    await prisma.eventLog.create({
      data: { kind: "invite.sent", refType: "invitation", refId: inv.id, data: JSON.stringify({ channel: "sms" }) },
    });
    return { ok: true as const, invitationId: inv.id };
  }
  await prisma.invitation.update({ where: { id: inv.id }, data: { status: "failed", error: res.error } });
  await prisma.eventLog.create({
    data: {
      kind: "invite.failed",
      refType: "invitation",
      refId: inv.id,
      data: JSON.stringify({ channel: "sms", error: res.error }),
    },
  });
  return { ok: false as const, error: res.error };
}

function needsFooter(body: string): boolean {
  const t = body.toLowerCase();
  return !t.includes("stop") && !t.includes("إيقاف") && !t.includes("ايقاف");
}

// P13-B — WhatsApp outbound.
//
// Shape mirrors sendEmail / sendSms: per-invitee row written in
// status="queued" before the provider call, then either "sent" on
// success or "failed" on error. The key difference is the
// message-shape decision — Meta Cloud API enforces template-vs-
// session-text discipline, and we honor it via `decideWhatsAppMessage`
// (pure planner in P13-A).
//
// Pre-dispatch checks (no_phone, unsubscribed) short-circuit WITHOUT
// writing a row — same rationale sendEmail / sendSms use. Writing a
// failed Invitation for every unsubscribed contact would flood the
// event log with expected refusals. A downstream auditor who wants
// to know "why didn't X get a WhatsApp?" consults the Unsubscribe
// table directly.
//
// Planner failure IS recorded as a failed Invitation — unlike the
// unsubscribed gate, a `no_template` / `template_vars_malformed`
// outcome signals a CAMPAIGN configuration bug the operator needs to
// see. Marking it as a concrete row + EventLog surfaces the failure
// in the campaign's send stats and audit trail.
//
// The function delegates to `performWhatsAppSend` which takes deps
// by injection. That split lets the choreography be unit-tested
// with in-memory fakes (see tests/unit/send-whatsapp.test.ts) while
// the sendWhatsApp entry point stays the thin real-deps wrapper the
// rest of the app imports. Same pattern the P12 delivery-webhook
// handler uses.
export interface WhatsAppSendDeps {
  isUnsubscribed: (phone: string) => Promise<boolean>;
  createInvitation: (data: {
    campaignId: string;
    inviteeId: string;
    channel: string;
    status: string;
    payload: string;
  }) => Promise<{ id: string }>;
  updateInvitation: (
    id: string,
    data: {
      status?: string;
      providerId?: string;
      sentAt?: Date;
      error?: string;
      // P17-C.4 — post-swap payload provenance. Optional because most
      // updates still touch only status/providerId/sentAt/error; only
      // the doc-header happy path writes a second update to overwrite
      // the create-time template descriptor with the same JSON plus
      // `documentMediaId`, `documentFilename`, and `documentUploadId`
      // once those are known. Audit readers look at this field to
      // answer "which media did this send actually attempt?".
      payload?: string;
    },
  ) => Promise<void>;
  createEventLog: (data: {
    kind: string;
    refType: string;
    refId: string;
    data: string;
  }) => Promise<void>;
  send: (
    message: import("./providers/types").WhatsAppMessage,
  ) => Promise<import("./providers/types").SendResult>;
  now: () => Date;

  // P17-C.3 — doc-header just-in-time upload seams. Both optional.
  // The intercept runs only when the plan has a template message
  // with a `headerDocument: { kind: "link" }` pointing at our own
  // `/api/files/<id>` route (the C.2 placeholder). For any other
  // plan shape these deps are never consulted, so plain-template
  // / text / session-text tests don't need to provide them. When
  // the intercept IS triggered and the deps are absent, the send
  // fails cleanly with `doc_upload_deps_missing` rather than
  // silently passing the unreachable internal URL through to the
  // provider.
  //
  // Split into two seams (load + upload) rather than combined into
  // a single `resolveHeaderDocument(link)` helper so tests can
  // exercise each failure class independently: a missing
  // FileUpload row is a DB fact, an upload failure is a network /
  // BSP fact, and conflating them would hide the distinction that
  // operators care about when debugging.
  loadFileUpload?: (id: string) => Promise<
    | { contents: Uint8Array; filename: string; contentType: string }
    | null
  >;
  uploadMedia?: (opts: {
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
  }) => Promise<
    | { ok: true; ref: import("./providers/types").WhatsAppDocumentRef }
    | { ok: false; error: string }
  >;
}

export type WhatsAppSendResult =
  | { ok: true; invitationId: string }
  | { ok: false; error: string };

export async function performWhatsAppSend(
  deps: WhatsAppSendDeps,
  campaign: Campaign,
  invitee: Invitee,
  opts: { sessionOpen?: boolean } = {},
): Promise<WhatsAppSendResult> {
  if (!invitee.phoneE164) return { ok: false, error: "no_phone" };
  if (await deps.isUnsubscribed(invitee.phoneE164)) {
    return { ok: false, error: "unsubscribed" };
  }

  // Build the message up-front so a planner-refusal creates the
  // Invitation row in a failed state immediately. Different from
  // sendSms's "render, then write queued row, then call provider"
  // because the WhatsApp planner has a synchronous reject path
  // (`no_template` / `template_vars_malformed`) that the SMS
  // renderer doesn't.
  const plan = decideWhatsAppMessage({
    campaign: {
      templateWhatsAppName: campaign.templateWhatsAppName,
      templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
      templateWhatsAppVariables: campaign.templateWhatsAppVariables,
      templateSms: campaign.templateSms,
      // P17-C.2 — pass the doc-upload FK to the planner. When set
      // alongside a template name+language, the planner attaches a
      // placeholder `headerDocument: { kind: "link", ... }` ref that
      // the chat confirm_send edge (P17-C.3) swaps for a Meta
      // `{ kind: "id", mediaId, filename }` after uploading the
      // bytes. In the current delivery path (direct provider send)
      // this project still works — the link placeholder goes through
      // to the provider, which will fail Meta's reachability check
      // on the internal URL. C.3's interception closes that loop.
      whatsappDocumentUploadId: campaign.whatsappDocumentUploadId,
    },
    to: invitee.phoneE164,
    vars: buildVars(campaign, invitee),
    sessionOpen: opts.sessionOpen,
  });

  // Persist attempt regardless of outcome. The payload column stores
  // the rendered body for session-text, or a JSON descriptor for
  // templates — the template body itself lives on Meta's side and
  // can't be reconstructed from our rows alone.
  const inv = await deps.createInvitation({
    campaignId: campaign.id,
    inviteeId: invitee.id,
    channel: "whatsapp",
    status: "queued",
    payload: payloadForPlan(plan),
  });

  if (!plan.ok) {
    await deps.updateInvitation(inv.id, {
      status: "failed",
      error: plan.reason,
    });
    await deps.createEventLog({
      kind: "invite.failed",
      refType: "invitation",
      refId: inv.id,
      data: JSON.stringify({ channel: "whatsapp", error: plan.reason }),
    });
    return { ok: false, error: plan.reason };
  }

  // P17-C.3 — just-in-time doc-header resolution. The planner (C.2)
  // emits a placeholder `headerDocument: { kind: "link" }` pointing
  // at our own `/api/files/<id>` route; Meta can't fetch that
  // (auth-required, non-public). So we intercept here, read the
  // FileUpload bytes, upload them to Meta via Taqnyat's `/media`
  // endpoint (P17-B), and rebuild the message with a Meta
  // `{ kind: "id", mediaId, filename }` ref before handing to the
  // provider. Any failure in that chain fails the invitation row
  // with a structured error — the chat propose_send / confirm_send
  // widgets (P17-C.5) will surface those errors to the operator.
  //
  // This intercept is idempotent per-send: each recipient re-uploads
  // the PDF. Meta's 30-day media retention means a cache could be
  // added later, but for the pilot (single-template, single-PDF
  // operator flow) the simplicity of "one upload per send" is worth
  // more than the saved round trips.
  let messageToSend = plan.message;
  if (
    messageToSend.kind === "template" &&
    messageToSend.headerDocument !== undefined &&
    messageToSend.headerDocument.kind === "link"
  ) {
    const swap = await resolveInternalDocLink(
      messageToSend.headerDocument.link,
      deps,
    );
    if (!swap.ok) {
      await deps.updateInvitation(inv.id, {
        status: "failed",
        error: swap.error,
      });
      await deps.createEventLog({
        kind: "invite.failed",
        refType: "invitation",
        refId: inv.id,
        data: JSON.stringify({ channel: "whatsapp", error: swap.error }),
      });
      return { ok: false, error: swap.error };
    }
    // P17-C.4 — provenance capture. The swap produced the mediaId we
    // need for audit; write it to the invitation's payload BEFORE the
    // send so a subsequent provider failure still leaves a row that
    // says "we attempted send with media X from upload Y." The swap's
    // `uploadId` is threaded out of `resolveInternalDocLink` rather
    // than re-parsed here so the link-shape matcher lives in exactly
    // one place. Guarded on `ref.kind === "id"` because the type of
    // `WhatsAppDocumentRef` permits a link-kind return (no current
    // `uploadMedia` impl produces one, but the type forces the check);
    // a link-ref would have no mediaId to record, so provenance stays
    // at the create-time descriptor for that (future) path.
    if (swap.ref.kind === "id") {
      await deps.updateInvitation(inv.id, {
        payload: payloadForDispatch({
          templateName: messageToSend.templateName,
          languageCode: messageToSend.languageCode,
          variables: messageToSend.variables,
          mediaId: swap.ref.mediaId,
          filename: swap.ref.filename ?? null,
          uploadId: swap.uploadId,
        }),
      });
    }
    messageToSend = { ...messageToSend, headerDocument: swap.ref };
  }

  const res = await deps.send(messageToSend);
  if (res.ok) {
    await deps.updateInvitation(inv.id, {
      status: "sent",
      providerId: res.providerId,
      sentAt: deps.now(),
    });
    await deps.createEventLog({
      kind: "invite.sent",
      refType: "invitation",
      refId: inv.id,
      data: JSON.stringify({ channel: "whatsapp", kind: messageToSend.kind }),
    });
    return { ok: true, invitationId: inv.id };
  }
  await deps.updateInvitation(inv.id, { status: "failed", error: res.error });
  await deps.createEventLog({
    kind: "invite.failed",
    refType: "invitation",
    refId: inv.id,
    data: JSON.stringify({ channel: "whatsapp", error: res.error }),
  });
  return { ok: false, error: res.error };
}

// Real-deps entry point. Everything else in the app imports this;
// tests import `performWhatsAppSend` directly with in-memory deps.
export async function sendWhatsApp(
  campaign: Campaign,
  invitee: Invitee,
  opts: { sessionOpen?: boolean } = {},
) {
  return performWhatsAppSend(
    {
      isUnsubscribed: (phone) => isUnsubscribed({ phone }),
      createInvitation: (data) =>
        prisma.invitation.create({ data, select: { id: true } }),
      updateInvitation: async (id, data) => {
        await prisma.invitation.update({ where: { id }, data });
      },
      createEventLog: async (data) => {
        await prisma.eventLog.create({ data });
      },
      send: (msg) => getWhatsAppProvider().send(msg),
      now: () => new Date(),
      // P17-C.3 — real-deps resolver wiring. Both deps are only
      // consulted when the plan carries a placeholder-link
      // headerDocument; plain-template / text sends never touch
      // them. Kept here (not split into a separate module) so the
      // DI seam + its real implementation sit in the same file
      // the rest of delivery choreography lives in — one hop
      // from the intercept that calls them.
      loadFileUpload: async (id) => {
        const row = await prisma.fileUpload.findUnique({
          where: { id },
          select: { contents: true, filename: true, contentType: true },
        });
        if (row === null) return null;
        // Prisma returns `Buffer` for Bytes columns; Buffer IS a
        // Uint8Array subclass, but constructing a fresh view keeps
        // the return type independent of the driver's choice and
        // ensures the consumer sees a plain Uint8Array (what
        // `taqnyatUploadMedia` expects).
        return {
          contents: new Uint8Array(row.contents),
          filename: row.filename,
          contentType: row.contentType,
        };
      },
      uploadMedia: async (upload) => {
        const token = process.env.TAQNYAT_WHATSAPP_TOKEN;
        if (!token || token.length === 0) {
          // Mirrors `taqnyatUploadMedia`'s own missing-token
          // refusal, but we don't even try to call it — the
          // upload would fail identically, and this way the
          // invitation's error string tells the operator exactly
          // what's missing without a network round-trip.
          return {
            ok: false,
            error: "whatsapp-media: missing token",
          };
        }
        return await taqnyatUploadMedia({
          token,
          bytes: upload.bytes,
          filename: upload.filename,
          mimeType: upload.mimeType,
        });
      },
    },
    campaign,
    invitee,
    opts,
  );
}

// Payload column content. Session-text stores the rendered body (so
// a reviewer can see exactly what was sent); template stores a JSON
// blob with template identifier + resolved positional variables
// (since the rendered body lives on Meta's side and can't be
// reconstructed from our rows). Document stores a descriptor of the
// media reference (id or link) plus any caption — same rationale as
// template: the rendered artifact lives on Meta's side and the
// audit row can only carry a reviewable identifier. Planner-refusal
// rows store a minimal error descriptor so the audit trail still
// has something structured to read.
//
// `document` is currently unreachable from `decideWhatsAppMessage`
// (the planner only emits text/template today — the document path
// is wired upstream of the planner in the invitation-PDF flow),
// but the union narrows exhaustively so the audit surface stays
// honest as soon as the planner starts emitting document plans.
function payloadForPlan(
  plan: ReturnType<typeof decideWhatsAppMessage>,
): string {
  if (!plan.ok) return JSON.stringify({ error: plan.reason });
  if (plan.message.kind === "text") return plan.message.text;
  if (plan.message.kind === "document") {
    return JSON.stringify({
      document: plan.message.document,
      caption: plan.message.caption ?? null,
    });
  }
  return JSON.stringify({
    template: plan.message.templateName,
    language: plan.message.languageCode,
    variables: plan.message.variables ?? [],
  });
}

// P17-C.4 — post-swap invitation payload. Invoked only after a
// successful C.3 placeholder→mediaId swap. Extends the template
// payload shape produced by `payloadForPlan` with three provenance
// fields the operator needs for audit:
//
//   - documentMediaId  : the Meta media id that went out on the wire.
//                        Lets an operator look up the delivered media
//                        on Meta's side via /v<n>/<mediaId>.
//   - documentFilename : the filename Meta echoed back for the upload
//                        (what recipients see in the chat list). Null
//                        if the BSP didn't carry one through.
//   - documentUploadId : the FileUpload row id the bytes came from.
//                        Lets "replay this send" later resolve the
//                        exact source even if the campaign's current
//                        upload has been rotated since.
//
// Two writes per doc send (create-time descriptor, post-swap
// provenance) is deliberate: a single deferred create would lose the
// "queued" audit state when the swap fails, and stashing the post-swap
// fields on the success-path status update would lose them on provider
// failure — the operator deserves to see "we attempted media X but the
// provider rejected" rather than a bare error with no media trail.
//
// The narrow-input parameter shape (rather than accepting a whole
// `WhatsAppMessage`) means the single caller in `performWhatsAppSend`
// does its own type narrowing at the call site and this helper never
// has to branch on message kind — every field it reads is required
// and typed up front.
function payloadForDispatch(opts: {
  templateName: string;
  languageCode: string;
  variables: string[] | undefined;
  mediaId: string;
  filename: string | null;
  uploadId: string;
}): string {
  return JSON.stringify({
    template: opts.templateName,
    language: opts.languageCode,
    variables: opts.variables ?? [],
    documentMediaId: opts.mediaId,
    documentFilename: opts.filename,
    documentUploadId: opts.uploadId,
  });
}

// P17-C.3 — placeholder-link → Meta-mediaId swap.
//
// The planner emits `headerDocument: { kind: "link", link:
// "/api/files/<id>" }` as a sentinel (C.2). Meta itself cannot
// fetch `/api/files/<id>` (auth-required, non-public), so this
// helper is the only path that makes the send actually succeed:
//
//   1. Parse the id out of the internal link shape.
//   2. Load the FileUpload row via the injected `loadFileUpload`
//      dep — returns bytes + filename + MIME.
//   3. Upload to Meta via the injected `uploadMedia` dep (wired
//      to `taqnyatUploadMedia` in the real-deps path, P17-B).
//   4. Return the Meta `{ kind: "id", mediaId, filename }` ref.
//
// Failure classes (each returns a distinct `error` string):
//   - `doc_link_not_internal`    — the link doesn't match the
//                                  internal /api/files/<id> shape.
//                                  Shouldn't happen with the current
//                                  planner output; defensive against
//                                  a future planner widening.
//   - `doc_upload_deps_missing`  — the intercept was triggered but
//                                  the caller didn't supply the
//                                  resolution deps. Treat as a
//                                  configuration error (likely a
//                                  test harness that didn't wire
//                                  them or a build where Taqnyat
//                                  isn't the configured BSP).
//   - `doc_not_found`            — the FileUpload row referenced by
//                                  the id doesn't exist. The
//                                  operator may have deleted the
//                                  file after configuring the
//                                  campaign. `onDelete: SetNull`
//                                  in the schema catches the common
//                                  case, but a race between "send"
//                                  and "delete" can still surface
//                                  this.
//   - `doc_empty`                — the row exists but has zero bytes
//                                  (shouldn't happen via the upload
//                                  route — /api/uploads rejects
//                                  empty files — but defensive
//                                  against a DB state bug).
//   - `doc_not_pdf`              — the row exists but is not a PDF.
//                                  The pilot's approved template is a
//                                  document-PDF header, so non-PDF
//                                  uploads are refused before the BSP
//                                  upload call.
//   - otherwise                  — passthrough of the uploadMedia
//                                  dep's error string (which includes
//                                  the HTTP status / BSP message
//                                  when relevant; see
//                                  `taqnyatUploadMedia` for the
//                                  exact format).
async function resolveInternalDocLink(
  link: string,
  deps: WhatsAppSendDeps,
): Promise<
  | {
      ok: true;
      ref: import("./providers/types").WhatsAppDocumentRef;
      // P17-C.4 — thread the parsed FileUpload id back to the caller
      // so it can be recorded in the invitation's payload provenance
      // without re-parsing the link. Keeping the parse + the threading
      // inside this function (rather than having the caller re-call
      // `parseInternalFileLink`) means the "what upload did we use?"
      // answer lives next to the "did we successfully upload it?"
      // answer, which is the coherent unit for downstream audit.
      uploadId: string;
    }
  | { ok: false; error: string }
> {
  const uploadId = parseInternalFileLink(link);
  if (uploadId === null) {
    return { ok: false, error: "doc_link_not_internal" };
  }
  if (!deps.loadFileUpload || !deps.uploadMedia) {
    return { ok: false, error: "doc_upload_deps_missing" };
  }
  const row = await deps.loadFileUpload(uploadId);
  if (row === null) {
    return { ok: false, error: "doc_not_found" };
  }
  if (row.contents.byteLength === 0) {
    return { ok: false, error: "doc_empty" };
  }
  if (!isPdfUploadContentType(row.contentType)) {
    return { ok: false, error: "doc_not_pdf" };
  }
  const uploadRes = await deps.uploadMedia({
    bytes: row.contents,
    filename: row.filename,
    mimeType: row.contentType,
  });
  if (!uploadRes.ok) return uploadRes;
  return { ok: true, ref: uploadRes.ref, uploadId };
}

// Extracts the FileUpload id from the planner's placeholder-link
// shape. Returns null if the link doesn't match the exact
// `/api/files/<non-empty-id>` pattern — NOT a generic URL parser.
// Matches the planner's output in `sendPlan.ts` one-to-one; a
// planner-side rename (e.g. `/api/files` → `/api/media`) would
// want to be reflected here too, and the strict match makes that
// drift surface as a test failure rather than a silent send
// failure at the provider level.
function parseInternalFileLink(link: string): string | null {
  const prefix = "/api/files/";
  if (!link.startsWith(prefix)) return null;
  const id = link.slice(prefix.length);
  if (id.length === 0) return null;
  // Refuse anything that looks like a continued path (another `/`)
  // or a querystring — the planner never emits those, so their
  // presence signals either a caller that bypassed the planner or
  // a future planner change that didn't update this resolver.
  if (id.includes("/") || id.includes("?") || id.includes("#")) {
    return null;
  }
  return id;
}
