import Link from "next/link";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { readAdminLocale, readAdminCalendar, formatAdminDate } from "@/lib/adminLocale";
import { FilterPill, FilterLabel } from "@/components/FilterPill";

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

  const channel =
    searchParams.channel === "email" || searchParams.channel === "sms" ? searchParams.channel : "all";
  const q = (searchParams.q ?? "").trim();
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  // Build the search OR scoped to channel: when Email is active we
  // don't want a phone substring to slip in a row via the address
  // column only because that row happens to also have an email set.
  const searchClauses = q
    ? (channel === "email"
        ? [{ email: { contains: q.toLowerCase() } }, { reason: { contains: q } }]
        : channel === "sms"
          ? [{ phoneE164: { contains: q } }, { reason: { contains: q } }]
          : [
              { email: { contains: q.toLowerCase() } },
              { phoneE164: { contains: q } },
              { reason: { contains: q } },
            ])
    : [];
  const where = {
    ...(channel === "email" ? { email: { not: null } } : {}),
    ...(channel === "sms" ? { phoneE164: { not: null } } : {}),
    ...(searchClauses.length > 0 ? { OR: searchClauses } : {}),
  };

  const [rows, total, totalAll, emailCount, smsCount] = await Promise.all([
    prisma.unsubscribe.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: PAGE_SIZE,
    }),
    prisma.unsubscribe.count({ where }),
    prisma.unsubscribe.count(),
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
      <div className="flex flex-wrap items-baseline gap-x-10 gap-y-3 mb-8">
        <Stat label={locale === "ar" ? "الإجمالي" : "Total"} value={totalAll} />
        <Stat label={locale === "ar" ? "بريد" : "Email"} value={emailCount} />
        <Stat label={locale === "ar" ? "رسائل" : "SMS"} value={smsCount} />
      </div>

      <div className="mb-6 flex items-center gap-3 flex-wrap">
        <form method="get" className="relative flex-1 max-w-md">
          <Icon name="search" size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            name="q"
            type="search"
            defaultValue={q}
            placeholder={locale === "ar" ? "بحث بالبريد / الرقم / السبب" : "email, phone, reason"}
            className="field ps-9"
          />
          {channel !== "all" ? <input type="hidden" name="channel" value={channel} /> : null}
        </form>
        <FilterLabel>{locale === "ar" ? "القناة" : "Channel"}</FilterLabel>
        <div className="flex items-center gap-1">
          <FilterPill href={qs({ channel: undefined, q: q || undefined })} active={channel === "all"}>All</FilterPill>
          <FilterPill href={qs({ channel: "email", q: q || undefined })} active={channel === "email"}>Email</FilterPill>
          <FilterPill href={qs({ channel: "sms", q: q || undefined })} active={channel === "sms"}>SMS</FilterPill>
        </div>
        {(q || channel !== "all") ? (
          <Link href="/unsubscribes" className="text-mini text-ink-500 hover:text-ink-900">Clear</Link>
        ) : null}
      </div>

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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span
        className="text-ink-900 tabular-nums"
        style={{
          fontSize: "24px",
          lineHeight: "28px",
          letterSpacing: "-0.015em",
          fontWeight: 500,
        }}
      >
        {value.toLocaleString()}
      </span>
      <span className="text-micro uppercase tracking-wider text-ink-400">{label}</span>
    </span>
  );
}
