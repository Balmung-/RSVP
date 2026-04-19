import type { Campaign, Invitee } from "@prisma/client";
import { prisma } from "./db";
import { getEmailProvider, getSmsProvider } from "./providers";
import { logAction } from "./audit";

// When ingest() decides an inbound reply is confidently attending /
// declined / stop, we send a one-line confirmation back on the same
// channel so the sender knows their reply landed. Three guarantees:
//
//   1. Bilingual — matches invitee.locale → campaign.locale → env default.
//   2. Not an Invitation row. Auto-acks are acknowledgments, not
//      invitations. Trace is via eventLog instead of Invitation status.
//   3. Silent on failure. An ack that bounces must never block the
//      inbound pipeline or surface to the reviewer — they'll see the
//      original reply in /inbox and act on that.
//
// Opt-out: set INBOUND_AUTO_ACK=false to disable entirely.

const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";
const BRAND = () => process.env.APP_BRAND ?? "Protocol";

function ackEnabled(): boolean {
  const v = (process.env.INBOUND_AUTO_ACK ?? "true").toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

function localeFor(invitee: Invitee, campaign: Campaign | null): "en" | "ar" {
  const raw = (invitee.locale ?? campaign?.locale ?? process.env.DEFAULT_LOCALE ?? "en").toLowerCase();
  return raw === "ar" ? "ar" : "en";
}

type AckIntent = "attending" | "declined" | "stop";

function emailCopy(
  intent: AckIntent,
  locale: "en" | "ar",
  campaignName: string,
  rsvpUrl: string,
): { subject: string; text: string } {
  const brand = BRAND();
  if (locale === "ar") {
    if (intent === "attending") {
      return {
        subject: `تأكيد الحضور — ${campaignName}`,
        text: `شكراً لكم. سجلنا حضوركم في «${campaignName}».\nلتعديل ردكم: ${rsvpUrl}\n\n— ${brand}`,
      };
    }
    if (intent === "declined") {
      return {
        subject: `اعتذار مسجّل — ${campaignName}`,
        text: `شكراً لإعلامنا. سجّلنا اعتذاركم عن «${campaignName}».\nإن تغيّرت الخطط: ${rsvpUrl}\n\n— ${brand}`,
      };
    }
    return {
      subject: `تم إلغاء الاشتراك`,
      text: `تم إلغاء اشتراككم من رسائل ${brand}. لن تصلكم دعوات جديدة.`,
    };
  }
  if (intent === "attending") {
    return {
      subject: `Confirmed — ${campaignName}`,
      text: `Thank you. We've saved you as attending ${campaignName}.\nTo change your reply: ${rsvpUrl}\n\n— ${brand}`,
    };
  }
  if (intent === "declined") {
    return {
      subject: `Regrets noted — ${campaignName}`,
      text: `Thank you for letting us know. We've recorded your regrets for ${campaignName}.\nIf plans change: ${rsvpUrl}\n\n— ${brand}`,
    };
  }
  return {
    subject: `Unsubscribed`,
    text: `You've been removed from ${brand} invitations. You won't receive further messages.`,
  };
}

function smsCopy(
  intent: AckIntent,
  locale: "en" | "ar",
  campaignName: string,
  rsvpUrl: string,
): string {
  const brand = BRAND();
  if (locale === "ar") {
    if (intent === "attending") return `${brand}: سجّلنا حضوركم في «${campaignName}». للتعديل: ${rsvpUrl}`;
    if (intent === "declined") return `${brand}: سجّلنا اعتذاركم عن «${campaignName}». للتعديل: ${rsvpUrl}`;
    return `${brand}: تم إلغاء الاشتراك. لن تصلكم رسائل جديدة.`;
  }
  if (intent === "attending") return `${brand}: confirmed for ${campaignName}. Change: ${rsvpUrl}`;
  if (intent === "declined") return `${brand}: regrets recorded for ${campaignName}. Change: ${rsvpUrl}`;
  return `${brand}: unsubscribed. You won't receive further messages.`;
}

// Sends a single acknowledgment. Returns silently on any error — we do
// not want a mis-routed ack to block the inbound pipeline.
export async function sendInboundAck(params: {
  channel: "email" | "sms";
  intent: AckIntent;
  invitee: Invitee;
  inboundMessageId: string;
}): Promise<void> {
  if (!ackEnabled()) return;

  const { channel, intent, invitee, inboundMessageId } = params;

  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: invitee.campaignId } });
    const locale = localeFor(invitee, campaign);
    const rsvpUrl = `${APP_URL().replace(/\/$/, "")}/rsvp/${invitee.rsvpToken}`;
    const campaignName = campaign?.name ?? "";

    if (channel === "email") {
      if (!invitee.email) return;
      const { subject, text } = emailCopy(intent, locale, campaignName, rsvpUrl);
      const res = await getEmailProvider().send({
        to: invitee.email,
        subject,
        text,
        html: text.replace(/\n/g, "<br>"),
        // Tell the receiving MTA this is an automated reply so their
        // own vacation responder / autoresponder skips it — guards
        // against ack ↔ OOO ping-pong even if our own parser missed it.
        headers: { "Auto-Submitted": "auto-replied" },
        // B3: reply ack comes FROM the same mailbox that sent the
        // original invitation — otherwise an invitee who got the
        // invite from team@ would see the confirmation arrive from
        // office@ and might mistake it for a phishing reply. If the
        // campaign lookup failed (campaign=null, shouldn't happen in
        // practice but the code above handles it), fall back to
        // office-wide.
        teamId: campaign?.teamId ?? null,
      });
      await logAction({
        kind: res.ok ? "inbound.ack.sent" : "inbound.ack.failed",
        refType: "inbound",
        refId: inboundMessageId,
        data: { channel, intent, error: res.ok ? null : res.error },
      });
      return;
    }

    // SMS ack — single short confirmation, no footer. The provider
    // already appended "Reply STOP" on the original invitation.
    if (!invitee.phoneE164) return;
    const body = smsCopy(intent, locale, campaignName, rsvpUrl);
    const res = await getSmsProvider().send({ to: invitee.phoneE164, body });
    await logAction({
      kind: res.ok ? "inbound.ack.sent" : "inbound.ack.failed",
      refType: "inbound",
      refId: inboundMessageId,
      data: { channel, intent, error: res.ok ? null : res.error },
    });
  } catch (e) {
    // Truly silent — log to the console, never to the user.
    console.error("[inbound-ack]", e);
  }
}
