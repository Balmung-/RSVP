import { prisma } from "./db";
import { getEmailProvider, getSmsProvider } from "./providers";
import { render, escapeHtml } from "./template";
import { t, type Locale } from "./i18n";
import type { Campaign, Invitee } from "@prisma/client";

// Orchestrates the outbound. Pure function of (campaign, invitee) → delivery.
// No retry daemon here — the scheduler lives outside. This engine is dumb,
// deterministic, and idempotent per (invitee, channel) via Invitation rows.

const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";
const BRAND = () => process.env.APP_BRAND ?? "Protocol";

function buildVars(c: Campaign, i: Invitee): Record<string, string> {
  return {
    name: i.fullName,
    title: i.title ?? "",
    organization: i.organization ?? "",
    campaign: c.name,
    venue: c.venue ?? "",
    eventAt: c.eventAt
      ? new Intl.DateTimeFormat("en-GB", {
          dateStyle: "long",
          timeStyle: "short",
          timeZone: process.env.APP_TIMEZONE ?? "Asia/Riyadh",
        }).format(c.eventAt)
      : "",
    rsvpUrl: `${APP_URL()}/rsvp/${i.rsvpToken}`,
    brand: BRAND(),
  };
}

function resolveLocale(c: Campaign, i: Invitee): Locale {
  const raw = (i.locale ?? c.locale ?? process.env.DEFAULT_LOCALE ?? "en").toLowerCase();
  return raw === "ar" ? "ar" : "en";
}

// Conditional {{#key}}...{{/key}} blocks — empty val strips the block.
// Recursive: repeats until a pass makes no change, so nested blocks resolve.
function condRender(tpl: string, vars: Record<string, string>): string {
  const re = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
  let prev = tpl;
  for (let i = 0; i < 10; i++) {
    const next = prev.replace(re, (_m, key: string, inner: string) => (vars[key] ? inner : ""));
    if (next === prev) break;
    prev = next;
  }
  return render(prev, vars);
}

export async function sendEmail(campaign: Campaign, invitee: Invitee) {
  if (!invitee.email) return { ok: false as const, error: "no_email" };
  const locale = resolveLocale(campaign, invitee);
  const vars = buildVars(campaign, invitee);
  const L = t(locale);
  const subject = condRender(campaign.subjectEmail || L.email.defaultSubject, vars);
  const text = condRender(campaign.templateEmail || L.email.body, vars);
  const html = textToHtml(text, L.dir);

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
  const locale = resolveLocale(campaign, invitee);
  const vars = buildVars(campaign, invitee);
  const L = t(locale);
  const body = condRender(campaign.templateSms || L.sms.body, vars);

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

// Escape first, then linkify escaped URLs (so ampersands stay intact in href).
// Trailing punctuation is trimmed from the linked URL.
function textToHtml(text: string, dir: "ltr" | "rtl"): string {
  const urlRe = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g;
  const body = escapeHtml(text)
    .replace(/\n/g, "<br/>")
    .replace(urlRe, '<a href="$1" style="color:#0a0a0a;text-decoration:underline">$1</a>');
  return `<!doctype html><html dir="${dir}"><body style="margin:0;padding:32px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#141414;line-height:1.55">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;padding:40px 32px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 8px 28px rgba(0,0,0,0.06)">
    ${body}
  </div>
</body></html>`;
}
