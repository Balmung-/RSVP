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
import { readAdminLocale, readAdminCalendar, adminDict, formatAdminDate } from "@/lib/adminLocale";
import { Badge } from "@/components/Badge";
import { InlineStat } from "@/components/Stat";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();
  const T = adminDict(locale);
  // Scope every campaign-linked query so a team-scoped editor only
  // sees tiles, lists, and activity relevant to their teams plus
  // office-wide. Admins pass through unscoped.
  const isAdmin = hasRole(me, "admin");
  const campaignScope = await scopedCampaignWhere(me.id, isAdmin);
  // EventLog has no campaignId column, so to keep the activity feed
  // scoped we upfront a list of visible campaign IDs and filter
  // refType=campaign rows against it. Capped at 1000 so the IN list
  // can never blow past Postgres's parameter ceiling; the overview
  // feed is always a small recent window anyway, so a scoped editor
  // with more campaigns than the cap sees their most recent 1000
  // campaigns' events — acceptable for an oversight surface.
  // Campaign-linked events with other refTypes (invitation/invitee/
  // stage) are dropped from the feed when scoped; the per-campaign
  // activity page remains the detailed view.
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
  const fmtFull = (d: Date | null | undefined) =>
    formatAdminDate(d, locale, calendar, { dateStyle: "medium", timeStyle: "short" });
  const fmtTime = (d: Date | null | undefined) =>
    formatAdminDate(d, locale, calendar, { timeStyle: "short" });
  const fmtDay = (d: Date | null | undefined) =>
    formatAdminDate(d, locale, calendar, { weekday: "long", day: "numeric", month: "short" });

  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86400_000);

  const [
    upcomingCampaigns,
    activeCampaigns,
    sendingCampaigns,
    totalResponses,
    attendingResponses,
    failedStages,
    failedInvitations,
    recentActivity,
    totalCampaigns,
    vips,
  ] = await Promise.all([
    prisma.campaign.findMany({
      where: {
        status: { in: ["draft", "active", "sending"] },
        eventAt: { gte: now, lte: weekAhead },
        ...campaignScope,
      },
      orderBy: { eventAt: "asc" },
      take: 6,
    }),
    prisma.campaign.count({ where: { status: "active", ...campaignScope } }),
    prisma.campaign.count({ where: { status: "sending", ...campaignScope } }),
    prisma.response.count({
      where: { respondedAt: { gte: weekAgo }, campaign: campaignScope },
    }),
    prisma.response.count({
      where: { respondedAt: { gte: weekAgo }, attending: true, campaign: campaignScope },
    }),
    prisma.campaignStage.findMany({
      where: { status: "failed", updatedAt: { gte: weekAgo }, campaign: campaignScope },
      include: { campaign: { select: { id: true, name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
    prisma.invitation.count({
      where: {
        status: { in: ["failed", "bounced"] },
        createdAt: { gte: weekAgo },
        campaign: campaignScope,
      },
    }),
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
      take: 25,
    }),
    prisma.campaign.count({ where: campaignScope }),
    vipWatch(campaignScope),
  ]);

  if (totalCampaigns === 0) {
    return (
      <Shell title={T.overview} crumb={T.thisWeek}>
        <EmptyState
          icon="calendar-check"
          title={locale === "ar" ? "لا شيء مجدول بعد" : "Nothing scheduled yet"}
          action={{ label: T.newCampaign, href: "/campaigns/new" }}
        >
          {locale === "ar"
            ? "هذه صفحة إشرافك — الفعاليات المقبلة والنشاط عبر المكتب وما يحتاج متابعة."
            : "This is your oversight page — upcoming events, activity across the office, and anything that needs attention."}
        </EmptyState>
      </Shell>
    );
  }

  const groupedByDay = groupByDay(upcomingCampaigns, fmtDay);

  return (
    <Shell
      title={T.overview}
      crumb={T.thisWeek}
      actions={
        <Link href="/campaigns/new" className="btn btn-primary">
          <Icon name="plus" size={14} />
          {T.newCampaign}
        </Link>
      }
    >
      {/* One horizontal reading strip instead of four stacked tiles.
          Primary numbers inline, secondary labels recessed. Delivery-
          failure count becomes a link when non-zero; otherwise it's
          just a quiet number. */}
      <div className="flex flex-wrap items-baseline gap-x-10 gap-y-3 mb-12 text-ink-600">
        <InlineStat label={T.activeCampaigns} value={activeCampaigns} />
        <InlineStat
          label={T.sendingNow}
          value={sendingCampaigns}
          tone={sendingCampaigns > 0 ? "hold" : undefined}
        />
        <InlineStat label={T.responsesThisWeek} value={totalResponses} />
        <InlineStat
          label={T.deliveryFailures7d}
          value={failedInvitations}
          tone={failedInvitations > 0 ? "fail" : undefined}
          href={failedInvitations > 0 ? "/deliverability" : undefined}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-10">
        <div className="flex flex-col gap-10">
          <section>
            <SectionHeader
              title={T.thisWeek}
              hint={locale === "ar" ? "الفعاليات خلال الأيام السبعة القادمة عبر جميع الحملات الفعّالة." : "Events in the next 7 days across every active campaign."}
              href="/campaigns"
              linkLabel={T.campaigns}
            />
            {upcomingCampaigns.length === 0 ? (
              <div className="panel-quiet p-8 text-center text-body text-ink-500">
                Nothing scheduled in the next 7 days.
              </div>
            ) : (
              <ol className="flex flex-col gap-6">
                {Array.from(groupedByDay.entries()).map(([day, rows]) => (
                  <li key={day}>
                    <div className="text-micro uppercase text-ink-400 mb-2">{day}</div>
                    <ul className="flex flex-col gap-2">
                      {rows.map((c) => (
                        <li key={c.id}>
                          <Link
                            href={`/campaigns/${c.id}`}
                            className="flex items-center justify-between rounded-xl border border-ink-100 bg-ink-0 px-4 py-3 hover:border-ink-200 transition-colors"
                          >
                            <div className="min-w-0">
                              <div className="text-body text-ink-900 truncate">{c.name}</div>
                              {c.venue ? (
                                <div className="text-mini text-ink-400 mt-0.5 truncate">{c.venue}</div>
                              ) : null}
                            </div>
                            <div className="shrink-0 text-mini tabular-nums text-ink-500">
                              {c.eventAt ? fmtTime(c.eventAt) : ""}
                            </div>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {failedStages.length > 0 ? (
            <section>
              <SectionHeader title="Needs attention" hint="Failed stages in the last 7 days." />
              {/* Thin rows instead of bordered signal-fail tiles — a
                  calm strip with one dot per entry. Matches the
                  AttentionStrip vocabulary used on the campaign
                  workspace so signal-fail color stays rare. */}
              <ul className="flex flex-col divide-y divide-ink-100 border-t border-b border-ink-100">
                {failedStages.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/campaigns/${s.campaign.id}?tab=schedule`}
                      className="flex items-center gap-3 py-3 text-mini hover:text-ink-900 transition-colors"
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-signal-fail shrink-0"
                        aria-hidden
                      />
                      <span className="text-ink-900 truncate">
                        {s.campaign.name}
                        <span className="text-ink-400 mx-1.5">·</span>
                        {s.kind.replace("_", " ")}
                      </span>
                      {s.error ? (
                        <span className="text-ink-500 truncate max-w-md">{s.error}</span>
                      ) : null}
                      <Icon name="chevron-right" size={14} className="text-ink-400 shrink-0 ms-auto" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section>
            <SectionHeader
              title={T.responsePulse}
              hint={
                locale === "ar"
                  ? `${attendingResponses.toLocaleString()} من ${totalResponses.toLocaleString()} سيحضرون (آخر ٧ أيام).`
                  : `${attendingResponses.toLocaleString()} of ${totalResponses.toLocaleString()} are attending (last 7 days).`
              }
            />
            <div className="panel-quiet p-6">
              <ResponseBar attending={attendingResponses} total={totalResponses} locale={locale} />
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-10">
          {vips.length > 0 ? (
            <section>
              <SectionHeader
                title={T.vipWatch}
                hint={locale === "ar" ? "كبار الشخصيات في الحملات الفعّالة." : "Royal, ministerial, and VIP invitees across active campaigns."}
                href="/contacts?tier=royal"
                linkLabel={T.contacts}
              />
              <ul className="panel-quiet divide-y divide-ink-100 overflow-hidden">
                {vips.slice(0, 8).map((i) => {
                  const r = i.response;
                  const tone = r ? (r.attending ? "live" : "fail") : "wait";
                  const label = r ? (r.attending ? "attending" : "declined") : "pending";
                  return (
                    <li key={i.id}>
                      <Link
                        href={`/campaigns/${i.campaign.id}?invitee=${i.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-50 transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-body text-ink-900 truncate">{i.contact!.fullName}</span>
                            <span className="text-micro uppercase text-ink-400">
                              {VIP_LABEL[i.contact!.vipTier as VipTier] ?? i.contact!.vipTier}
                            </span>
                          </div>
                          <div className="text-mini text-ink-400 mt-0.5 truncate">
                            {i.campaign.name}
                            {i.contact!.organization ? ` · ${i.contact!.organization}` : ""}
                          </div>
                        </div>
                        <Badge tone={tone}>{label}</Badge>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section>
            <SectionHeader
              title={T.activity}
              hint={locale === "ar" ? "آخر ٢٥ حدث في المكتب." : "Latest 25 events across the office."}
              href="/events"
              linkLabel={T.events}
            />
            {recentActivity.length === 0 ? (
              <div className="panel-quiet p-8 text-center text-body text-ink-500">
                {locale === "ar" ? "لا يوجد نشاط هذا الأسبوع." : "Nothing yet this week."}
              </div>
            ) : (
              <ol className="flex flex-col">
                {recentActivity.map((e) => (
                  <ActivityRow key={e.id} event={e} fmt={fmtFull} />
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </Shell>
  );
}

function SectionHeader({
  title,
  hint,
  href,
  linkLabel,
}: {
  title: string;
  hint?: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-end justify-between mb-4">
      <div>
        <h2 className="text-sub text-ink-900">{title}</h2>
        {hint ? <p className="text-body text-ink-500 mt-1">{hint}</p> : null}
      </div>
      {href && linkLabel ? (
        <Link href={href} className="text-mini text-ink-500 hover:text-ink-900 transition-colors">
          {linkLabel} →
        </Link>
      ) : null}
    </div>
  );
}


function ResponseBar({
  attending,
  total,
  locale,
}: {
  attending: number;
  total: number;
  locale: "en" | "ar";
}) {
  const declined = Math.max(0, total - attending);
  const attendPct = total ? Math.round((attending / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-body text-ink-700">
          {attending.toLocaleString()} {locale === "ar" ? "سيحضرون" : "attending"}
        </span>
        <span className="text-mini text-ink-400 tabular-nums">{attendPct}%</span>
      </div>
      <div className="h-2 rounded-full bg-ink-100 overflow-hidden">
        <div
          className="h-full bg-signal-live transition-all duration-500"
          style={{ width: `${attendPct}%` }}
        />
      </div>
      <div className="flex items-baseline justify-between mt-3 text-mini text-ink-500">
        <span>
          {declined.toLocaleString()} {locale === "ar" ? "معتذرون" : "declined"}
        </span>
      </div>
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
  const toneClass =
    tone === "success" ? "bg-signal-live"
    : tone === "warn" ? "bg-signal-hold"
    : tone === "fail" ? "bg-signal-fail"
    : "bg-ink-300";
  return (
    <li className="flex gap-3 py-3 border-b border-ink-100 last:border-b-0">
      <span className={`dot mt-2 shrink-0 ${toneClass}`} />
      <div className="flex-1 min-w-0">
        <div className="text-body text-ink-800">{line}</div>
        <div className="text-mini text-ink-400 mt-0.5 tabular-nums">{fmt(event.createdAt)}</div>
      </div>
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
