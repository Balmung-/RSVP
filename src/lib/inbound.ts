import { prisma } from "./db";
import { submitResponse } from "./rsvp";
import { logAction } from "./audit";
import { sendInboundAck } from "./inbound-ack";

// Intent parser + inbound router. Keeps the state machine simple:
//   captured  → extract token (email subaddress OR SMS body)
//             → identify invitee (token OR sender phone)
//             → classify intent
//   if attending/declined with confidence → auto-apply via submitResponse
//   if stop/unsubscribe → write Unsubscribe row
//   if auto-reply → status=ignored, note=auto
//   else → status=needs_review for a human

export type Intent = "attending" | "declined" | "stop" | "autoreply" | "unknown";

const YES_KEYWORDS = [
  "yes", "yep", "yeah", "sure", "confirm", "confirmed", "confirming",
  "accept", "accepting", "attend", "attending", "will attend", "ill be there",
  "i'll be there", "count me in",
  // Arabic
  "نعم", "تأكيد", "سأحضر", "احضر", "سوف أحضر", "موافق", "موافقة",
];
const NO_KEYWORDS = [
  "no", "nope", "regret", "decline", "declining", "cant", "can't", "cannot",
  "unable", "unavailable", "apologies", "apology", "won't", "wont",
  "not attending", "not able",
  // Arabic
  "لا", "اعتذر", "أعتذر", "لن احضر", "لن أحضر", "لا استطيع", "لا أستطيع",
];
const STOP_KEYWORDS = [
  "stop", "unsubscribe", "remove me", "opt out", "opt-out", "end",
  "إلغاء", "ألغي", "أزل", "ايقاف", "إيقاف",
];
const AUTOREPLY_INDICATORS = [
  "out of office", "ooo", "auto-reply", "automatic reply", "vacation",
  "i'm away", "currently unavailable",
  "auto-submitted:", "x-autoreply:",
];

// Pull `<token>` from a local-part subaddress: rsvp+<token>@<domain>.
// Returns null when nothing looks like a token.
export function extractTokenFromAddress(to: string | null | undefined): string | null {
  if (!to) return null;
  const local = to.split("@")[0] ?? "";
  const plus = local.indexOf("+");
  if (plus < 0) return null;
  const t = local.slice(plus + 1).trim();
  if (!/^[a-zA-Z0-9_-]{10,64}$/.test(t)) return null;
  return t;
}

// Search body for a known token (fallback when To: is missing the subaddress).
// Matches rsvp+<token>@ OR rsvp: <token> OR a standalone 32-char slug.
export function extractTokenFromBody(body: string): string | null {
  const addr = body.match(/rsvp\+([a-zA-Z0-9_-]{10,64})@/);
  if (addr) return addr[1];
  const tag = body.match(/rsvp[:\s]+([a-zA-Z0-9_-]{20,64})/i);
  if (tag) return tag[1];
  return null;
}

export function parseIntent(body: string, rawHeaders?: string | null): {
  intent: Intent;
  confidence: "high" | "medium" | "low";
  note?: string;
} {
  const t = normalize(body);
  const h = normalize(rawHeaders ?? "");

  if (AUTOREPLY_INDICATORS.some((k) => t.includes(k) || h.includes(k))) {
    return { intent: "autoreply", confidence: "high", note: "auto-reply indicator detected" };
  }
  if (STOP_KEYWORDS.some((k) => t.startsWith(k) || t === k)) {
    return { intent: "stop", confidence: "high" };
  }
  const firstLine = t.split(/\n|\./).map((s) => s.trim()).filter(Boolean)[0] ?? "";
  const bodyMatches = (keywords: string[], target: string) =>
    keywords.filter((k) => target.includes(k)).length;

  const yesHits = bodyMatches(YES_KEYWORDS, t);
  const noHits = bodyMatches(NO_KEYWORDS, t);
  if (yesHits >= 2 && noHits === 0) return { intent: "attending", confidence: "high" };
  if (noHits >= 2 && yesHits === 0) return { intent: "declined", confidence: "high" };

  // Single-word replies ("yes" / "لا") on the first line.
  if (YES_KEYWORDS.includes(firstLine)) return { intent: "attending", confidence: "high", note: "single-word yes" };
  if (NO_KEYWORDS.includes(firstLine)) return { intent: "declined", confidence: "high", note: "single-word no" };
  if (STOP_KEYWORDS.includes(firstLine)) return { intent: "stop", confidence: "high", note: "single-word stop" };

  if (yesHits > noHits && yesHits > 0) return { intent: "attending", confidence: "medium" };
  if (noHits > yesHits && noHits > 0) return { intent: "declined", confidence: "medium" };
  return { intent: "unknown", confidence: "low" };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Main processor — called by both email + SMS webhooks after they
// normalize their provider-specific payload into a common shape.
export async function ingest(params: {
  channel: "email" | "sms";
  providerId?: string | null;
  fromAddress: string;
  toAddress?: string | null;
  subject?: string | null;
  body: string;
  rawHeaders?: string | null;
}) {
  const token =
    extractTokenFromAddress(params.toAddress ?? null) ??
    extractTokenFromBody(params.body);
  const invitee = token
    ? await prisma.invitee.findUnique({ where: { rsvpToken: token } })
    : await findInviteeByContact(params.channel, params.fromAddress);

  const parsed = parseIntent(params.body, params.rawHeaders ?? null);
  const confident =
    parsed.confidence === "high" &&
    (parsed.intent === "attending" || parsed.intent === "declined" || parsed.intent === "stop");

  const msg = await prisma.inboundMessage.create({
    data: {
      channel: params.channel,
      providerId: params.providerId ?? null,
      fromAddress: params.fromAddress.slice(0, 300),
      toAddress: params.toAddress?.slice(0, 300) ?? null,
      subject: params.subject?.slice(0, 500) ?? null,
      body: params.body.slice(0, 20_000),
      rawHeaders: params.rawHeaders?.slice(0, 10_000) ?? null,
      token: token ?? null,
      inviteeId: invitee?.id ?? null,
      intent: parsed.intent,
      status: "new",
      note: parsed.note ?? null,
    },
  });

  // Unsubscribe is applied even if we can't match an invitee (we log the
  // sender so future sends skip them). We only ack if we have an invitee
  // to address — acking an unknown sender risks spamming a spoofed From.
  if (parsed.intent === "stop" && parsed.confidence === "high") {
    await applyUnsubscribe(params.channel, params.fromAddress);
    await finalize(msg.id, "processed", "Unsubscribe recorded.");
    if (invitee) {
      await sendInboundAck({
        channel: params.channel,
        intent: "stop",
        invitee,
        inboundMessageId: msg.id,
      });
    }
    return { id: msg.id, outcome: "unsubscribed" as const };
  }
  if (parsed.intent === "autoreply") {
    await finalize(msg.id, "ignored", "Auto-reply ignored.");
    return { id: msg.id, outcome: "ignored" as const };
  }
  if (!invitee) {
    await finalize(msg.id, "needs_review", "Sender could not be matched to an invitee.");
    return { id: msg.id, outcome: "needs_review" as const };
  }
  if (confident && (parsed.intent === "attending" || parsed.intent === "declined")) {
    const r = await submitResponse({
      token: invitee.rsvpToken,
      attending: parsed.intent === "attending",
      message: `Via ${params.channel} reply.`,
    });
    if (r.ok) {
      await finalize(msg.id, "processed", `Auto-applied (${parsed.intent}).`);
      await logAction({
        kind: "inbound.applied",
        refType: "invitee",
        refId: invitee.id,
        data: { channel: params.channel, intent: parsed.intent },
      });
      await sendInboundAck({
        channel: params.channel,
        intent: parsed.intent,
        invitee,
        inboundMessageId: msg.id,
      });
      return { id: msg.id, outcome: "applied" as const, intent: parsed.intent };
    }
    await finalize(msg.id, "needs_review", `Auto-apply failed: ${r.reason}.`);
    return { id: msg.id, outcome: "needs_review" as const };
  }
  await finalize(msg.id, "needs_review", "Intent unclear — reviewer required.");
  return { id: msg.id, outcome: "needs_review" as const };
}

async function finalize(id: string, status: string, note: string) {
  await prisma.inboundMessage.update({
    where: { id },
    data: { status, note, processedAt: new Date() },
  });
}

async function findInviteeByContact(channel: "email" | "sms", from: string) {
  if (channel === "email") {
    return prisma.invitee.findFirst({ where: { email: from.toLowerCase() } });
  }
  return prisma.invitee.findFirst({ where: { phoneE164: from } });
}

export type UnsubscribeReason = "inbound_stop" | "public_page" | "one_click" | "admin";

export async function applyUnsubscribe(
  channel: "email" | "sms",
  address: string,
  reason: UnsubscribeReason = "inbound_stop",
) {
  if (channel === "email") {
    const email = address.toLowerCase();
    await prisma.unsubscribe.upsert({
      where: { email },
      create: { email, reason },
      update: {},
    });
  } else {
    await prisma.unsubscribe.upsert({
      where: { phoneE164: address },
      create: { phoneE164: address, reason },
      update: {},
    });
  }
}

export async function isUnsubscribed(params: { email?: string | null; phone?: string | null }) {
  const or: Array<{ email?: string } | { phoneE164?: string }> = [];
  if (params.email) or.push({ email: params.email.toLowerCase() });
  if (params.phone) or.push({ phoneE164: params.phone });
  if (or.length === 0) return false;
  const hit = await prisma.unsubscribe.findFirst({ where: { OR: or } });
  return !!hit;
}

export async function applyReviewerDecision(
  messageId: string,
  decision: "apply_attending" | "apply_declined" | "unsubscribe" | "ignore",
) {
  const msg = await prisma.inboundMessage.findUnique({
    where: { id: messageId },
    include: { invitee: true },
  });
  if (!msg) return { ok: false as const, reason: "not_found" };
  if (decision === "ignore") {
    await finalize(messageId, "ignored", "Ignored by reviewer.");
    return { ok: true as const };
  }
  if (decision === "unsubscribe") {
    await applyUnsubscribe(msg.channel as "email" | "sms", msg.fromAddress);
    await finalize(messageId, "processed", "Unsubscribe recorded by reviewer.");
    if (msg.invitee) {
      await sendInboundAck({
        channel: msg.channel as "email" | "sms",
        intent: "stop",
        invitee: msg.invitee,
        inboundMessageId: messageId,
      });
    }
    return { ok: true as const };
  }
  if (!msg.invitee) {
    await finalize(messageId, "needs_review", "No linked invitee — cannot apply decision.");
    return { ok: false as const, reason: "no_invitee" };
  }
  const attending = decision === "apply_attending";
  const r = await submitResponse({
    token: msg.invitee.rsvpToken,
    attending,
    message: `Via ${msg.channel} reply, reviewed.`,
  });
  if (!r.ok) {
    await finalize(messageId, "needs_review", `Apply failed: ${r.reason}`);
    return { ok: false as const, reason: r.reason };
  }
  await finalize(messageId, "processed", attending ? "Reviewer applied attending." : "Reviewer applied declined.");
  await logAction({
    kind: "inbound.reviewed",
    refType: "invitee",
    refId: msg.invitee.id,
    data: { decision, channel: msg.channel },
  });
  await sendInboundAck({
    channel: msg.channel as "email" | "sms",
    intent: attending ? "attending" : "declined",
    invitee: msg.invitee,
    inboundMessageId: messageId,
  });
  return { ok: true as const };
}

// Unsubscribe URL helpers — used by List-Unsubscribe and the /unsubscribe/<token> page.
export function unsubscribeUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/unsubscribe/${token}`;
}
