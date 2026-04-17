import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { findInviteeByToken, submitResponse } from "@/lib/rsvp";
import { t, type Locale } from "@/lib/i18n";
import RsvpForm from "./form";

export const dynamic = "force-dynamic";

async function submit(formData: FormData) {
  "use server";
  const token = String(formData.get("token"));
  const attending = String(formData.get("attending")) === "yes";
  const guestsCount = Number(formData.get("guestsCount") ?? 0);
  const message = String(formData.get("message") ?? "");
  const h = headers();
  await submitResponse({
    token,
    attending,
    guestsCount,
    message,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
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
  const locale: Locale =
    (qsLocale === "ar" || qsLocale === "en"
      ? qsLocale
      : (inv.locale ?? inv.campaign.locale ?? "en")) === "ar"
      ? "ar"
      : "en";

  const L = t(locale);
  const closed =
    inv.campaign.status === "closed" ||
    inv.campaign.status === "archived" ||
    (inv.campaign.rsvpDeadline ? inv.campaign.rsvpDeadline < new Date() : false);

  return (
    <div
      dir={L.dir}
      className="min-h-screen bg-ink-50 flex items-center justify-center px-6 py-20"
      style={{ fontFamily: 'var(--font-sans)' }}
    >
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-2 justify-center mb-10 text-ink-400">
          <span className="h-1.5 w-1.5 rounded-full bg-ink-900" />
          <span className="text-xs tracking-wider uppercase">{process.env.APP_BRAND ?? "Einai"}</span>
          <span className="mx-2 text-ink-300">·</span>
          <a href={`?lang=${locale === "ar" ? "en" : "ar"}`} className="text-xs hover:text-ink-900">
            {locale === "ar" ? "English" : "العربية"}
          </a>
        </div>

        <div className="panel p-10 sm:p-14">
          <div className="text-center mb-10">
            <div className="text-xs uppercase tracking-wider text-ink-400 mb-3">{L.rsvp.title}</div>
            <h1 className="text-2xl sm:text-3xl font-medium tracking-tightest text-ink-900">
              {inv.campaign.name}
            </h1>
            {inv.campaign.venue ? (
              <p className="text-sm text-ink-500 mt-2">{inv.campaign.venue}</p>
            ) : null}
            {inv.campaign.eventAt ? (
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

          {closed ? (
            <div className="mt-10 text-center text-sm text-ink-500">{L.rsvp.closed}</div>
          ) : (
            <RsvpForm
              token={params.token}
              locale={locale}
              guestsAllowed={inv.guestsAllowed}
              action={submit}
              existing={
                inv.response
                  ? {
                      attending: inv.response.attending,
                      guestsCount: inv.response.guestsCount,
                      message: inv.response.message ?? "",
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
    }).format(d);
  } catch {
    return d.toISOString();
  }
}
