import { prisma } from "./db";
import { getEmailProvider, getSmsProvider } from "./providers";
import { renderEmail, renderSms } from "./preview";
import type { Campaign, Invitee } from "@prisma/client";

// Orchestrates the outbound. Pure function of (campaign, invitee) → delivery.
// Rendering lives in preview.ts so test-send and the preview UI share exactly
// the same output as the real send.

export async function sendEmail(campaign: Campaign, invitee: Invitee) {
  if (!invitee.email) return { ok: false as const, error: "no_email" };
  const { subject, text, html } = renderEmail(campaign, invitee);

  const inv = await prisma.invitation.create({
    data: { campaignId: campaign.id, inviteeId: invitee.id, channel: "email", status: "queued", payload: text },
  });

  const res = await getEmailProvider().send({ to: invitee.email, subject, html, text });
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
  const { body } = renderSms(campaign, invitee);

  const inv = await prisma.invitation.create({
    data: { campaignId: campaign.id, inviteeId: invitee.id, channel: "sms", status: "queued", payload: body },
  });

  const res = await getSmsProvider().send({ to: invitee.phoneE164, body });
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
