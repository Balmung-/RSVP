import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { applyUnsubscribe } from "@/lib/inbound";
import { t, type Locale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// Public unsubscribe page. Shown when a recipient clicks the
// List-Unsubscribe link OR the footer link in the invitation email.
// GET shows a confirmation; POST applies the unsubscribe.

async function confirm(formData: FormData) {
  "use server";
  const token = String(formData.get("token"));
  const inv = await prisma.invitee.findUnique({
    where: { rsvpToken: token },
    select: { email: true, phoneE164: true },
  });
  if (!inv) return;
  if (inv.email) await applyUnsubscribe("email", inv.email, "public_page");
  if (inv.phoneE164) await applyUnsubscribe("sms", inv.phoneE164, "public_page");
}

export default async function Unsubscribe({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { lang?: string };
}) {
  const invitee = await prisma.invitee.findUnique({
    where: { rsvpToken: params.token },
    include: { campaign: true },
  });
  if (!invitee) notFound();

  const qsLocale = (searchParams.lang ?? "").toLowerCase();
  const locale: Locale =
    qsLocale === "ar" || qsLocale === "en"
      ? qsLocale
      : invitee.locale === "ar" || invitee.campaign.locale === "ar"
        ? "ar"
        : "en";
  const L = t(locale);

  // Check current state.
  const email = invitee.email?.toLowerCase() ?? null;
  const unsub = email
    ? await prisma.unsubscribe.findUnique({ where: { email } })
    : invitee.phoneE164
      ? await prisma.unsubscribe.findUnique({ where: { phoneE164: invitee.phoneE164 } })
      : null;
  const alreadyUnsubscribed = !!unsub;

  return (
    <div
      dir={L.dir}
      lang={locale}
      className="min-h-screen bg-ink-50 flex items-center justify-center px-6 py-20"
      style={{ fontFamily: "var(--font-sans)" }}
    >
      <div className="panel max-w-md w-full p-10 text-center">
        <div className="text-micro uppercase text-ink-400 mb-3">
          {process.env.APP_BRAND ?? "Einai"}
        </div>
        <h1 className="text-sub text-ink-900 mb-2">
          {locale === "ar" ? "إلغاء الاشتراك" : "Unsubscribe"}
        </h1>
        <p className="text-body text-ink-500 mb-6">
          {alreadyUnsubscribed
            ? locale === "ar"
              ? "تم إلغاء اشتراكك سابقاً."
              : "You've already unsubscribed. No further messages will be sent."
            : locale === "ar"
              ? `لن تستقبل المزيد من الرسائل عن ${invitee.campaign.name} أو الفعاليات المستقبلية.`
              : `You'll stop receiving messages about ${invitee.campaign.name} and any future events.`}
        </p>
        {!alreadyUnsubscribed ? (
          <form action={confirm} className="flex flex-col gap-3">
            <input type="hidden" name="token" value={params.token} />
            <button className="btn btn-primary w-full py-3">
              {locale === "ar" ? "تأكيد إلغاء الاشتراك" : "Confirm unsubscribe"}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
