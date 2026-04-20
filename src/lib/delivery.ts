import { prisma } from "./db";
import { getEmailProvider, getSmsProvider, getWhatsAppProvider } from "./providers";
import { renderEmail, renderSms, buildVars } from "./preview";
import { isUnsubscribed, unsubscribeUrl } from "./inbound";
import { decideWhatsAppMessage } from "./providers/whatsapp/sendPlan";
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
    return { ok: false, error: plan.reason };
  }

  const res = await deps.send(plan.message);
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
      data: JSON.stringify({ channel: "whatsapp", kind: plan.message.kind }),
    });
    return { ok: true, invitationId: inv.id };
  }
  await deps.updateInvitation(inv.id, { status: "failed", error: res.error });
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
// reconstructed from our rows). Planner-refusal rows store a
// minimal error descriptor so the audit trail still has something
// structured to read.
function payloadForPlan(
  plan: ReturnType<typeof decideWhatsAppMessage>,
): string {
  if (!plan.ok) return JSON.stringify({ error: plan.reason });
  if (plan.message.kind === "text") return plan.message.text;
  return JSON.stringify({
    template: plan.message.templateName,
    language: plan.message.languageCode,
    variables: plan.message.variables ?? [],
  });
}
