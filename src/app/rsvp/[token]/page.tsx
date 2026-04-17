import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { findInviteeByToken, submitResponse, type SubmitResult } from "@/lib/rsvp";
import { rateLimit } from "@/lib/ratelimit";
import { t, type Locale } from "@/lib/i18n";
import RsvpForm from "./form";

export const dynamic = "force-dynamic";

async function submit(_prev: SubmitResult | null, formData: FormData): Promise<SubmitResult> {
  "use server";
  const token = String(formData.get("token") ?? "");
  const attending = String(formData.get("attending")) === "yes";
  const guestsCount = Number(formData.get("guestsCount") ?? 0);
  const message = String(formData.get("message") ?? "");
  const eventOptionId = String(formData.get("eventOptionId") ?? "") || null;

  // Collect q_<id> form fields into an answers map.
  const answers: Record<string, string | string[]> = {};
  formData.forEach((value, key) => {
    if (!key.startsWith("q_")) return;
    const qid = key.slice(2);
    if (answers[qid] == null) {
      answers[qid] = String(value);
    } else if (Array.isArray(answers[qid])) {
      (answers[qid] as string[]).push(String(value));
    } else {
      answers[qid] = [answers[qid] as string, String(value)];
    }
  });

  const h = headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const rl = rateLimit(`rsvp:${ip}`, { capacity: 6, refillPerSec: 0.1 });
  if (!rl.ok) return { ok: false, reason: "rate_limited" };

  return submitResponse({
    token,
    attending,
    guestsCount,
    message,
    eventOptionId,
    answers,
    ip,
    userAgent: h.get("user-agent") ?? undefined,
  });
}

export default async function RsvpPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { lang?: string };
}) {
  const inv = await findInviteeByToken(params.token);
  if (!inv) notFound();

  const qsLocale = (searchParams.lang ?? "").toLowerCase();
  const fromInvitee = inv.locale ?? inv.campaign.locale ?? "en";
  const locale: Locale =
    (qsLocale === "ar" || qsLocale === "en" ? qsLocale : fromInvitee) === "ar" ? "ar" : "en";

  const L = t(locale);
  const closed =
    inv.campaign.status === "closed" ||
    inv.campaign.status === "archived" ||
    (inv.campaign.rsvpDeadline ? inv.campaign.rsvpDeadline < new Date() : false);

  // Filter questions based on prior attending state (if any). For first-time
  // visitors we show "always" questions up-front; state-gated ones reveal once
  // they pick yes/no.
  const priorAttending = inv.response?.attending ?? null;

  const brandColor = inv.campaign.brandColor && /^#[0-9A-Fa-f]{3,8}$/.test(inv.campaign.brandColor)
    ? inv.campaign.brandColor
    : null;
  const cssVars = brandColor
    ? ({ ["--brand" as unknown as string]: brandColor } as React.CSSProperties)
    : undefined;

  return (
    <div
      dir={L.dir}
      lang={locale}
      className={`min-h-screen bg-ink-50 flex items-center justify-center px-6 py-20 ${brandColor ? "brand" : ""}`}
      style={{ fontFamily: "var(--font-sans)", ...cssVars }}
    >
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-2 justify-center mb-10 text-ink-400">
          {inv.campaign.brandLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={inv.campaign.brandLogoUrl} alt="" className="h-5 w-auto opacity-80" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-ink-900" />
          )}
          <span className="text-xs tracking-wider uppercase">{process.env.APP_BRAND ?? "Einai"}</span>
          <span className="mx-2 text-ink-300">·</span>
          <a href={`?lang=${locale === "ar" ? "en" : "ar"}`} className="text-xs hover:text-ink-900">
            {locale === "ar" ? "English" : "العربية"}
          </a>
        </div>

        <div className="panel p-10 sm:p-14">
          {inv.campaign.brandHeroUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={inv.campaign.brandHeroUrl}
              alt=""
              className="w-full h-40 object-cover rounded-lg mb-10"
            />
          ) : null}

          <div className="text-center mb-10">
            <div className="text-xs uppercase tracking-wider text-ink-400 mb-3">{L.rsvp.title}</div>
            <h1 className="text-2xl sm:text-3xl font-medium tracking-tightest text-ink-900">
              {inv.campaign.name}
            </h1>
            {inv.campaign.venue && inv.campaign.eventOptions.length === 0 ? (
              <p className="text-sm text-ink-500 mt-2">{inv.campaign.venue}</p>
            ) : null}
            {inv.campaign.eventAt && inv.campaign.eventOptions.length === 0 ? (
              <p className="text-sm text-ink-500 mt-1 tabular-nums">
                {formatWhen(inv.campaign.eventAt, locale)}
              </p>
            ) : null}
          </div>

          <div className="border-t border-ink-100 pt-8">
            <p className="text-sm text-ink-500">{L.rsvp.hello}</p>
            <p className="text-lg text-ink-900 mt-1">
              {inv.title ? <span className="text-ink-500">{inv.title} </span> : null}
              {inv.fullName}
            </p>
            <p className="text-sm text-ink-500 mt-4">{L.rsvp.youAreInvited}</p>
          </div>

          {inv.campaign.attachments.length > 0 ? (
            <ul className="mt-6 border-t border-ink-100 pt-6 space-y-2">
              {inv.campaign.attachments.map((a) => (
                <li key={a.id}>
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-ink-700 hover:text-ink-900 underline-offset-4 hover:underline"
                  >
                    <span className="text-[11px] uppercase tracking-wider text-ink-400">{a.kind}</span>
                    <span>{a.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          {closed ? (
            <div className="mt-10 text-center text-sm text-ink-500">{L.rsvp.closed}</div>
          ) : (
            <RsvpForm
              token={params.token}
              locale={locale}
              guestsAllowed={inv.guestsAllowed}
              action={submit}
              eventOptions={inv.campaign.eventOptions.map((o) => ({
                id: o.id,
                label: o.label,
                startsAt: o.startsAt.toISOString(),
                venue: o.venue,
              }))}
              questions={inv.campaign.questions.map((q) => ({
                id: q.id,
                prompt: q.prompt,
                kind: q.kind,
                required: q.required,
                options: q.options,
                showWhen: q.showWhen,
              }))}
              priorAttending={priorAttending}
              existing={
                inv.response
                  ? {
                      attending: inv.response.attending,
                      guestsCount: inv.response.guestsCount,
                      message: inv.response.message ?? "",
                      eventOptionId: inv.response.eventOptionId ?? null,
                      answers: Object.fromEntries(inv.response.answers.map((a) => [a.questionId, a.value])),
                    }
                  : null
              }
            />
          )}

          {inv.campaign.rsvpDeadline && !closed ? (
            <p className="text-xs text-ink-400 text-center mt-8">
              {L.rsvp.deadline} {formatWhen(inv.campaign.rsvpDeadline, locale)}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatWhen(d: Date, locale: Locale) {
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar-SA" : "en-GB", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: process.env.APP_TIMEZONE ?? "Asia/Riyadh",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}
