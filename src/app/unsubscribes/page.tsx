import Link from "next/link";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { readAdminLocale, readAdminCalendar, adminDict, formatAdminDate } from "@/lib/adminLocale";

export const dynamic = "force-dynamic";

// Audit-facing list of everyone who has opted out. Government-grade
// deployments need a clean answer to "who did we stop messaging and
// when" — this page is the clean answer. Admin-only; CSV export
// lives at /api/unsubscribes/export.

const PAGE_SIZE = 50;

type SearchParams = {
  q?: string;
  channel?: string;
  page?: string;
};

export default async function UnsubscribesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole("admin");
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();
  const T = adminDict(locale);

  const channel =
    searchParams.channel === "email" || searchParams.channel === "sms" ? searchParams.channel : "all";
  const q = (searchParams.q ?? "").trim();
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  const where = {
    ...(channel === "email" ? { email: { not: null } } : {}),
    ...(channel === "sms" ? { phoneE164: { not: null } } : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q.toLowerCase() } },
            { phoneE164: { contains: q } },
            { reason: { contains: q } },
          ],
        }
      : {}),
  };

  const [rows, total, emailCount, smsCount] = await Promise.all([
    prisma.unsubscribe.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: PAGE_SIZE,
    }),
    prisma.unsubscribe.count({ where }),
    prisma.unsubscribe.count({ where: { email: { not: null } } }),
    prisma.unsubscribe.count({ where: { phoneE164: { not: null } } }),
  ]);

  const qs = (patch: Partial<SearchParams>) => {
    const next: SearchParams = { ...searchParams, ...patch };
    // Filter/search reset should start on page 1.
    if ("channel" in patch || "q" in patch) delete next.page;
    const entries = Object.entries(next).filter(([, v]) => v && v !== "all");
    return entries.length
      ? `/unsubscribes?${new URLSearchParams(entries as [string, string][]).toString()}`
      : "/unsubscribes";
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Shell
      title={locale === "ar" ? "قائمة المنسحبين" : "Unsubscribes"}
      crumb={locale === "ar" ? "المنسحبون من المراسلات" : "People who've opted out"}
      actions={
        <Link href="/api/unsubscribes/export" className="btn btn-ghost">
          <Icon name="download" size={14} />
          {locale === "ar" ? "تصدير CSV" : "Export CSV"}
        </Link>
      }
    >
      <div className="grid grid-cols-3 gap-6 mb-8 max-w-3xl">
        <Tile label={locale === "ar" ? "الإجمالي" : "Total"} value={emailCount + smsCount} />
        <Tile label={locale === "ar" ? "بريد" : "Email"} value={emailCount} />
        <Tile label={locale === "ar" ? "رسائل" : "SMS"} value={smsCount} />
      </div>

      <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 flex-1 max-w-xs">
          <span className="text-micro uppercase text-ink-400">{T.search}</span>
          <input
            name="q"
            type="search"
            defaultValue={q}
            placeholder={locale === "ar" ? "بحث بالبريد / الرقم / السبب" : "email, phone, reason"}
            className="field"
          />
        </label>
        {channel !== "all" ? <input type="hidden" name="channel" value={channel} /> : null}
        <button className="btn btn-ghost">{T.filter}</button>
        <div className="flex items-center gap-1 ms-auto">
          <FilterPill href={qs({ channel: undefined, q: q || undefined })} active={channel === "all"}>All</FilterPill>
          <FilterPill href={qs({ channel: "email", q: q || undefined })} active={channel === "email"}>Email</FilterPill>
          <FilterPill href={qs({ channel: "sms", q: q || undefined })} active={channel === "sms"}>SMS</FilterPill>
        </div>
      </form>

      {rows.length === 0 ? (
        <EmptyState
          icon="inbox"
          title={locale === "ar" ? "لا يوجد منسحبون" : "No unsubscribes yet"}
        >
          {locale === "ar"
            ? "سيظهر هنا من يطلب إيقاف الرسائل — سواء من رابط البريد أو برسالة STOP."
            : "Anyone who opts out via a one-click email link or a reply-STOP will show here."}
        </EmptyState>
      ) : (
        <>
          <p className="text-mini text-ink-500 mb-3 tabular-nums">
            {locale === "ar"
              ? `عرض ${rows.length.toLocaleString()} من ${total.toLocaleString()}`
              : `Showing ${rows.length.toLocaleString()} of ${total.toLocaleString()}`}
          </p>
          <ul className="panel divide-y divide-ink-100 overflow-hidden max-w-4xl">
            {rows.map((r) => (
              <li key={r.id} className="px-5 py-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-body text-ink-900 truncate">
                    {r.email ?? r.phoneE164 ?? "—"}
                  </div>
                  <div className="text-mini text-ink-500 mt-0.5">
                    <span className="uppercase tracking-wider text-ink-400">
                      {r.email ? "email" : "sms"}
                    </span>
                    {r.reason ? <span className="ms-2">· {humanReason(r.reason, locale)}</span> : null}
                  </div>
                </div>
                <div className="text-mini text-ink-400 tabular-nums shrink-0">
                  {formatAdminDate(r.createdAt, locale, calendar)}
                </div>
              </li>
            ))}
          </ul>

          {totalPages > 1 ? (
            <nav className="mt-4 flex items-center justify-between max-w-4xl text-mini text-ink-500">
              <Link
                href={qs({ page: String(Math.max(1, page - 1)) })}
                className={`btn btn-ghost text-mini ${page <= 1 ? "pointer-events-none opacity-40" : ""}`}
              >
                <Icon name="chevron-left" size={14} /> Prev
              </Link>
              <span className="tabular-nums">
                Page {page} / {totalPages}
              </span>
              <Link
                href={qs({ page: String(Math.min(totalPages, page + 1)) })}
                className={`btn btn-ghost text-mini ${page >= totalPages ? "pointer-events-none opacity-40" : ""}`}
              >
                Next <Icon name="chevron-right" size={14} />
              </Link>
            </nav>
          ) : null}
        </>
      )}
    </Shell>
  );
}

function humanReason(reason: string, locale: "en" | "ar"): string {
  if (reason === "inbound_stop") return locale === "ar" ? "عبر رد STOP" : "via reply-STOP";
  if (reason === "one_click") return locale === "ar" ? "نقرة واحدة بالبريد" : "via one-click email";
  if (reason === "public_page") return locale === "ar" ? "صفحة الإلغاء العامة" : "via /unsubscribe page";
  return reason;
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="panel-quiet p-5 flex flex-col gap-1">
      <span className="text-micro uppercase text-ink-400">{label}</span>
      <span
        className="text-ink-900 tabular-nums"
        style={{ fontSize: "28px", lineHeight: "34px", letterSpacing: "-0.02em", fontWeight: 500 }}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function FilterPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`px-2.5 py-1 rounded-md text-mini transition-colors ${
        active
          ? "bg-ink-900 text-ink-0"
          : "bg-ink-100 text-ink-600 hover:bg-ink-200 hover:text-ink-900"
      }`}
    >
      {children}
    </Link>
  );
}
