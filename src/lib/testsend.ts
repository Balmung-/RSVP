import { getEmailProvider, getSmsProvider } from "./providers";
import { renderEmail, renderSms, type Recipient } from "./preview";
import { normalizeEmail, normalizePhone } from "./contact";
import { newRsvpToken } from "./tokens";
import type { Campaign } from "@prisma/client";

// Test send uses the same renderers as production but does not persist an
// Invitation row and does not touch the invitee list. Subject + body are
// clearly marked [TEST] so the recipient never confuses a preview with the
// real blast — the rendered RSVP link is live-shaped but points to a token
// that was never saved and will 404.

export type TestSendResult = { ok: true; providerId: string } | { ok: false; error: string };

function synthetic(name: string): Recipient {
  return {
    fullName: name || "Test Recipient",
    title: null,
    organization: null,
    locale: null,
    rsvpToken: newRsvpToken(),
  };
}

const EMAIL_BANNER =
  '<div style="background:#fff7e6;border:1px solid #f5c97b;color:#8a5a00;padding:10px 14px;border-radius:10px;font-size:12px;margin-bottom:16px">' +
  "This is a test send. The RSVP link below is a preview and will 404." +
  "</div>";

const SMS_PREFIX = "[TEST] ";

export async function testSendEmail(
  campaign: Campaign,
  toRaw: string,
  name?: string,
): Promise<TestSendResult> {
  const to = normalizeEmail(toRaw);
  if (!to) return { ok: false, error: "invalid_email" };
  const { subject, text, html } = renderEmail(campaign, synthetic(name ?? "Test Recipient"));
  const taggedSubject = `[TEST] ${subject}`;
  const taggedHtml = html.replace("<div style=\"max-width:560px", `${EMAIL_BANNER}<div style="max-width:560px`);
  const taggedText = `[TEST] This is a test send. The RSVP link will 404.\n\n${text}`;
  // Route the test through the SAME mailbox the real campaign would
  // use (B3). Otherwise an admin sending a test from the Operations
  // page on a team campaign would see "[TEST] …" land in their
  // office-wide inbox while the real send later lands in the team
  // mailbox — exactly the kind of silent routing mismatch test sends
  // are supposed to catch.
  return (await getEmailProvider().send({
    to,
    subject: taggedSubject,
    html: taggedHtml,
    text: taggedText,
    teamId: campaign.teamId,
  })) as TestSendResult;
}

export async function testSendSms(
  campaign: Campaign,
  toRaw: string,
  name?: string,
): Promise<TestSendResult> {
  const to = normalizePhone(toRaw, "SA");
  if (!to) return { ok: false, error: "invalid_phone" };
  const { body } = renderSms(campaign, synthetic(name ?? "Test Recipient"));
  return (await getSmsProvider().send({ to, body: SMS_PREFIX + body })) as TestSendResult;
}
