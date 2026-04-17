import { prisma } from "./db";
import { getEmailProvider, getSmsProvider } from "./providers";
import { render } from "./template";
import { t, type Locale } from "./i18n";
import type { Campaign, Invitee } from "@prisma/client";

// Orchestrates the outbound. Pure function of (campaign, invitee) → delivery result.
// No retry daemon here — keep the engine dumb and deterministic, the scheduler is separate.

const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";
const BRAND = () => process.env.APP_BRAND ?? "Protocol";

function buildVars(c: Campaign, i: Invitee) {
  return {
    name: i.fullName,
    title: i.title ?? "",
    organization: i.organization ?? "",
    campaign: c.name,
    venue: c.venue ?? "",
    eventAt: c.eventAt ? c.eventAt.toISOString().slice(0, 16).replace("T", " ") : "",
    rsvpUrl: `${APP_URL()}/rsvp/${i.rsvpToken}`,
    brand: BRAND(),
  };
}

function resolveLocale(c: Campaign, i: Invitee): Locale {
  const raw = (i.locale ?? c.locale ?? process.env.DEFAULT_LOCALE ?? "en").toLowerCase();
  return raw === "ar" ? "ar" : "en";
}

// Conditional {{#key}}...{{/key}} sections — empty val → section removed.
function condRender(tpl: string, vars: Record<string, string>) {
  const stripped = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, inner: string) =>
    vars[key] ? inner : "",
  );
  return render(stripped, vars);
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

function textToHtml(text: string, dir: "ltr" | "rtl") {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br/>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0a0a0a;text-decoration:underline">$1</a>');
  return `<!doctype html><html dir="${dir}"><body style="margin:0;padding:32px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#141414;line-height:1.55">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;padding:40px 32px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 8px 28px rgba(0,0,0,0.06)">
    ${escaped}
  </div>
</body></html>`;
}
