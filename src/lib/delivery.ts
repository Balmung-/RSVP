import { prisma } from "./db";
import { getEmailProvider, getSmsProvider } from "./providers";
import { renderEmail, renderSms } from "./preview";
import { isUnsubscribed, unsubscribeUrl } from "./inbound";
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

// RFC 2369 / 8058 style List-Unsubscribe headers. Email clients with a
// one-click button rely on the https URL; MUAs that send a mailto when
// the user clicks unsubscribe hit our inbound parser.
function listUnsubscribeHeaders(invitee: Invitee): Record<string, string> {
  const httpUrl = unsubscribeUrl(APP_URL(), invitee.rsvpToken);
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
