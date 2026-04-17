import type { Campaign } from "@prisma/client";
import { t, type Locale } from "./i18n";
import { render, escapeHtml } from "./template";

// Pure rendering for the preview route + test send + real delivery. Mirrors
// delivery.ts's needs but does not touch the DB or the providers.
//
// The renderers accept a narrow Recipient shape — any subset of Invitee with
// the fields actually read here. Lets testsend synthesize a recipient without
// casting against the full Prisma model.

export type Recipient = {
  fullName: string;
  title: string | null;
  organization: string | null;
  locale: string | null;
  rsvpToken: string;
};

const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";
const BRAND = () => process.env.APP_BRAND ?? "Protocol";
const TZ = () => process.env.APP_TIMEZONE ?? "Asia/Riyadh";

function vars(c: Campaign, r: Recipient): Record<string, string> {
  return {
    name: r.fullName,
    title: r.title ?? "",
    organization: r.organization ?? "",
    campaign: c.name,
    venue: c.venue ?? "",
    eventAt: c.eventAt
      ? new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: TZ() }).format(c.eventAt)
      : "",
    rsvpUrl: `${APP_URL()}/rsvp/${r.rsvpToken}`,
    unsubscribeUrl: `${APP_URL()}/unsubscribe/${r.rsvpToken}`,
    brand: BRAND(),
  };
}

function resolveLocale(c: Campaign, r: Recipient): Locale {
  const raw = (r.locale ?? c.locale ?? process.env.DEFAULT_LOCALE ?? "en").toLowerCase();
  return raw === "ar" ? "ar" : "en";
}

function condRender(tpl: string, v: Record<string, string>): string {
  const re = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
  let prev = tpl;
  for (let i = 0; i < 10; i++) {
    const next = prev.replace(re, (_m, key: string, inner: string) => (v[key] ? inner : ""));
    if (next === prev) break;
    prev = next;
  }
  return render(prev, v);
}

export function renderEmail(c: Campaign, r: Recipient) {
  const locale = resolveLocale(c, r);
  const L = t(locale);
  const v = vars(c, r);
  const subject = condRender(c.subjectEmail || L.email.defaultSubject, v);
  const text = condRender(c.templateEmail || L.email.body, v);
  const textWithFooter = appendUnsubscribeFooter(text, v.unsubscribeUrl, locale);
  const html = textToHtml(textWithFooter, L.dir, v.unsubscribeUrl, locale);
  return { locale, dir: L.dir, subject, text: textWithFooter, html };
}

function appendUnsubscribeFooter(text: string, unsubUrl: string, locale: string): string {
  if (text.includes(unsubUrl)) return text;
  const line =
    locale === "ar"
      ? `\n\n—\nلإلغاء الاشتراك: ${unsubUrl}`
      : `\n\n—\nUnsubscribe: ${unsubUrl}`;
  return text + line;
}

export function renderSms(c: Campaign, r: Recipient) {
  const locale = resolveLocale(c, r);
  const L = t(locale);
  const v = vars(c, r);
  const body = condRender(c.templateSms || L.sms.body, v);
  return { locale, dir: L.dir, body };
}

export function textToHtml(
  text: string,
  dir: "ltr" | "rtl",
  unsubUrl?: string,
  locale?: string,
): string {
  const urlRe = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g;
  const body = escapeHtml(text)
    .replace(/\n/g, "<br/>")
    .replace(urlRe, '<a href="$1" style="color:#0a0a0a;text-decoration:underline">$1</a>');
  const unsubLine =
    unsubUrl
      ? `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #e8e8e6;color:#8e8e8a;font-size:11px;line-height:16px">
        <a href="${unsubUrl}" style="color:#8e8e8a;text-decoration:underline">${locale === "ar" ? "إلغاء الاشتراك" : "Unsubscribe from future messages"}</a>
      </div>`
      : "";
  return `<!doctype html><html dir="${dir}"><body style="margin:0;padding:32px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#141414;line-height:1.55">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;padding:40px 32px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 8px 28px rgba(0,0,0,0.06)">
    ${body}
    ${unsubLine}
  </div>
</body></html>`;
}
