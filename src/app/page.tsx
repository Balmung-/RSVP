import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { scopedCampaignWhere } from "@/lib/teams";
import { phrase, type ActivityRecord } from "@/lib/activity";
import { vipWatch, VIP_LABEL, type VipTier } from "@/lib/contacts";
import {
  readAdminLocale,
  readAdminCalendar,
  adminDict,
  formatAdminDate,
} from "@/lib/adminLocale";

export const dynamic = "force-dynamic";

// Overview: a calm single-column stream. No tiles, no gauges, no
// stat strip. Three things the operator actually needs when they
// first walk in: what's happening this week, who requires attention,
// what just happened. Tonal signal (dots) does the visual work;
// numbers live on the pages that own them.

export default async function Dashboard() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();
  const T = adminDict(locale);
  const isAdmin = hasRole(me, "admin");
  const campaignScope = await scopedCampaignWhere(me.id, isAdmin);

  // EventLog has no campaignId column — cap the scoped ID list so
  // the IN clause can't blow past Postgres's parameter ceiling.
  const VISIBLE_CAMPAIGN_CAP = 1000;
  const visibleCampaignIds = isAdmin
    ? null
    : (
        await prisma.campaign.findMany({
          where: campaignScope,
          select: { id: true },
          orderBy: { updatedAt: "desc" },
          take: VISIBLE_CAMPAIGN_CAP,
        })
      ).map((c) => c.id);

  const fmtFull = (d: Date) =>
    formatAdminDate(d, locale, calendar, { dateStyle: "medium", timeStyle: "short" });
  const fmtDay = (d: Date) =>
    formatAdminDate(d, locale, calendar, { weekday: "long", day: "numeric", month: "short" });
  const fmtTime = (d: Date) => formatAdminDate(d, locale, calendar, { timeStyle: "short" });

  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86400_000);

  const [upcomingCampaigns, totalCampaigns, recentActivity, vips] = await Promise.all([
    prisma.campaign.findMany({
      where: {
        status: { in: ["draft", "active", "sending"] },
        eventAt: { gte: now, lte: weekAhead },
        ...campaignScope,
      },
      orderBy: { eventAt: "asc" },
      take: 8,
    }),
    prisma.campaign.count({ where: campaignScope }),
    prisma.eventLog.findMany({
      where: {
        createdAt: { gte: weekAgo },
        ...(visibleCampaignIds === null
          ? {}
          : {
              OR: [
                { refType: null },
                {
                  refType: {
                    notIn: ["campaign", "invitation", "invitee", "stage", "response"],
                  },
                },
                { refType: "campaign", refId: { in: visibleCampaignIds } },
              ],
            }),
      },
      include: { actor: { select: { email: true, fullName: true } } },
      orderBy: { createdAt: "desc" },
      take: 15,
    }),
    vipWatch(campaignScope),
  ]);

  if (totalCampaigns === 0) {
    return (
      <Shell title={T.overview}>
        <EmptyState
          icon="calendar-check"
          title={locale === "ar" ? "لا شيء مجدول بعد" : "Nothing scheduled yet"}
          action={{ label: T.newCampaign, href: "/campaigns/new" }}
        >
          {locale === "ar"
            ? "الفعاليات المقبلة والنشاط عبر المكتب وكل ما يحتاج متابعة يظهر هنا."
            : "Upcoming events, activity across the office, and anything that needs attention will live here."}
        </EmptyState>
      </Shell>
    );
  }

  const groupedByDay = groupByDay(upcomingCampaigns, fmtDay);

  return (
    <Shell
      title={T.overview}
      actions={
        <Link href="/campaigns/new" className="btn btn-primary">
          <Icon name="plus" size={14} />
          {T.newCampaign}
        </Link>
      }
    >
      <div className="flex flex-col gap-12 max-w-3xl">
        {/* This week — one line per campaign, grouped by day. */}
        <section>
          <SectionHead
            title={T.thisWeek}
            href="/campaigns"
            linkLabel={T.campaigns}
          />
          {upcomingCampaigns.length === 0 ? (
            <p className="text-mini text-ink-500">
              {locale === "ar"
                ? "لا فعاليات خلال الأيام السبعة القادمة."
                : "Nothing scheduled in the next seven days."}
            </p>
          ) : (
            <ol className="flex flex-col">
              {Array.from(groupedByDay.entries()).map(([day, rows]) => (
                <li
                  key={day}
                  className="flex flex-col gap-1 py-3 border-b border-ink-100 last:border-b-0"
                >
                  <div className="text-micro uppercase tracking-wider text-ink-400">{day}</div>
                  <ul className="flex flex-col">
                    {rows.map((c) => (
                      <li key={c.id}>
                        <Link
                          href={`/campaigns/${c.id}`}
                          className="flex items-baseline justify-between gap-4 py-1 group"
                        >
                          <span className="text-body text-ink-900 group-hover:underline truncate">
                            {c.name}
                          </span>
                          <span className="text-mini text-ink-400 tabular-nums shrink-0">
                            {c.venue ? <span className="me-2">{c.venue}</span> : null}
                            {c.eventAt ? fmtTime(c.eventAt) : null}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* VIP watch — thin rows. No badge panels, just dot + name + context. */}
        {vips.length > 0 ? (
          <section>
            <SectionHead title={T.vipWatch} href="/contacts?tier=royal" linkLabel={T.contacts} />
            <ul className="flex flex-col divide-y divide-ink-100 border-t border-b border-ink-100">
              {vips.slice(0, 8).map((i) => {
                const tier = (i.contact!.vipTier as VipTier) ?? "standard";
                const r = i.response;
                const tone =
                  tier === "royal"
                    ? "bg-signal-fail"
                    : tier === "minister"
                      ? "bg-signal-hold"
                      : "bg-ink-400";
                const state = r
                  ? r.attending
                    ? "attending"
                    : "declined"
                  : "pending";
                return (
                  <li key={i.id}>
                    <Link
                      href={`/campaigns/${i.campaign.id}?invitee=${i.id}`}
                      className="flex items-center gap-3 py-2.5 text-body hover:text-ink-900 transition-colors min-w-0"
                    >
                      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${tone}`} aria-hidden />
                      <span className="text-ink-900 truncate">{i.contact!.fullName}</span>
                      <span className="text-micro uppercase tracking-wider text-ink-400 shrink-0">
                        {VIP_LABEL[tier] ?? tier}
                      </span>
                      <span className="text-mini text-ink-500 truncate">
                        {i.campaign.name}
                        {i.contact!.organization ? ` · ${i.contact!.organization}` : ""}
                      </span>
                      <span className="ms-auto text-mini text-ink-400 shrink-0">{state}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {/* Activity — thin stream, no panel chrome, one dot per row. */}
        <section>
          <SectionHead title={T.activity} href="/events" linkLabel={T.events} />
          {recentActivity.length === 0 ? (
            <p className="text-mini text-ink-500">
              {locale === "ar" ? "لا نشاط خلال الأسبوع." : "Nothing this week."}
            </p>
          ) : (
            <ol className="flex flex-col">
              {recentActivity.map((e) => (
                <ActivityRow key={e.id} event={e} fmt={fmtFull} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </Shell>
  );
}

// Section heading: sub-scale title on the left, optional link label
// on the right. No hint paragraph — the content speaks for itself.
function SectionHead({
  title,
  href,
  linkLabel,
}: {
  title: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-baseline justify-between mb-3">
      <h2 className="text-sub text-ink-900">{title}</h2>
      {href && linkLabel ? (
        <Link href={href} className="text-mini text-ink-500 hover:text-ink-900 transition-colors">
          {linkLabel} →
        </Link>
      ) : null}
    </div>
  );
}

function ActivityRow({
  event,
  fmt,
}: {
  event: ActivityRecord;
  fmt: (d: Date) => string;
}) {
  const { line, tone } = phrase(event);
  const dot =
    tone === "success"
      ? "bg-signal-live"
      : tone === "warn"
        ? "bg-signal-hold"
        : tone === "fail"
          ? "bg-signal-fail"
          : "bg-ink-300";
  return (
    <li className="flex items-baseline gap-3 py-2 border-b border-ink-100 last:border-b-0 min-w-0">
      <span
        className={`h-1.5 w-1.5 rounded-full translate-y-[-1px] shrink-0 ${dot}`}
        aria-hidden
      />
      <span className="text-body text-ink-800 truncate">{line}</span>
      <span className="ms-auto text-mini text-ink-400 tabular-nums shrink-0">
        {fmt(event.createdAt)}
      </span>
    </li>
  );
}

type UC = { id: string; name: string; venue: string | null; eventAt: Date | null };
function groupByDay(rows: UC[], fmtDay: (d: Date) => string): Map<string, UC[]> {
  const out = new Map<string, UC[]>();
  for (const r of rows) {
    if (!r.eventAt) continue;
    const key = fmtDay(r.eventAt);
    const arr = out.get(key) ?? [];
    arr.push(r);
    out.set(key, arr);
  }
  return out;
}
