import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { phrase, type ActivityRecord } from "@/lib/activity";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fullFmt = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TZ,
});
const shortFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: TZ });

export default async function Dashboard() {
  if (!(await isAuthed())) redirect("/login");

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
  ] = await Promise.all([
    prisma.campaign.findMany({
      where: {
        status: { in: ["draft", "active", "sending"] },
        eventAt: { gte: now, lte: weekAhead },
      },
      orderBy: { eventAt: "asc" },
      take: 6,
    }),
    prisma.campaign.count({ where: { status: "active" } }),
    prisma.campaign.count({ where: { status: "sending" } }),
    prisma.response.count({ where: { respondedAt: { gte: weekAgo } } }),
    prisma.response.count({ where: { respondedAt: { gte: weekAgo }, attending: true } }),
    prisma.campaignStage.findMany({
      where: { status: "failed", updatedAt: { gte: weekAgo } },
      include: { campaign: { select: { id: true, name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
    prisma.invitation.count({
      where: { status: { in: ["failed", "bounced"] }, createdAt: { gte: weekAgo } },
    }),
    prisma.eventLog.findMany({
      where: { createdAt: { gte: weekAgo } },
      include: { actor: { select: { email: true, fullName: true } } },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    prisma.campaign.count(),
  ]);

  if (totalCampaigns === 0) {
    return (
      <Shell title="Overview" crumb="This week">
        <EmptyState
          icon="calendar-check"
          title="Nothing scheduled yet"
          action={{ label: "Create the first campaign", href: "/campaigns/new" }}
        >
          This is your oversight page — upcoming events, activity across the office,
          and anything that needs attention. It fills up as campaigns run.
        </EmptyState>
      </Shell>
    );
  }

  const groupedByDay = groupByDay(upcomingCampaigns);

  return (
    <Shell
      title="Overview"
      crumb="This week"
      actions={
        <Link href="/campaigns/new" className="btn btn-primary">
          <Icon name="plus" size={14} />
          New campaign
        </Link>
      }
    >
      <div className="grid grid-cols-4 gap-6 mb-12">
        <Tile label="Active campaigns" value={activeCampaigns} />
        <Tile
          label="Sending now"
          value={sendingCampaigns}
          tone={sendingCampaigns > 0 ? "hold" : "default"}
        />
        <Tile label="Responses this week" value={totalResponses} />
        <Tile
          label="Delivery failures (7d)"
          value={failedInvitations}
          tone={failedInvitations > 0 ? "fail" : "default"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-10">
        <div className="flex flex-col gap-10">
          <section>
            <SectionHeader
              title="This week"
              hint="Events in the next 7 days across every active campaign."
              href="/campaigns"
              linkLabel="All campaigns"
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
                              {c.eventAt ? fullFmt.format(c.eventAt).split(",").pop()?.trim() : ""}
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
              <ul className="flex flex-col gap-2">
                {failedStages.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/campaigns/${s.campaign.id}?tab=schedule`}
                      className="flex items-center justify-between rounded-xl border border-signal-fail/30 bg-signal-fail/5 px-4 py-3 hover:bg-signal-fail/10 transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="text-body text-ink-900 truncate">
                          {s.campaign.name} · {s.kind.replace("_", " ")}
                        </div>
                        {s.error ? (
                          <div className="text-mini text-signal-fail mt-0.5 truncate max-w-xl">{s.error}</div>
                        ) : null}
                      </div>
                      <Icon name="chevron-right" size={14} className="text-ink-400 shrink-0" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section>
            <SectionHeader
              title="Response pulse"
              hint={`${attendingResponses.toLocaleString()} of ${totalResponses.toLocaleString()} are attending (last 7 days).`}
            />
            <div className="panel-quiet p-6">
              <ResponseBar attending={attendingResponses} total={totalResponses} />
            </div>
          </section>
        </div>

        <section>
          <SectionHeader title="Activity" hint="Latest 25 events across the office." href="/events" linkLabel="Full log" />
          {recentActivity.length === 0 ? (
            <div className="panel-quiet p-8 text-center text-body text-ink-500">
              Nothing yet this week.
            </div>
          ) : (
            <ol className="flex flex-col">
              {recentActivity.map((e) => (
                <ActivityRow key={e.id} event={e} />
              ))}
            </ol>
          )}
        </section>
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

function Tile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "hold" | "fail";
}) {
  const dot =
    tone === "hold" ? "bg-signal-hold animate-pulse"
    : tone === "fail" ? "bg-signal-fail"
    : "bg-ink-300";
  return (
    <div className="panel-quiet p-5 flex flex-col gap-1">
      <span className="inline-flex items-center gap-2 text-micro uppercase text-ink-400">
        <span className={`dot ${dot}`} />
        {label}
      </span>
      <span
        className="text-ink-900 tabular-nums"
        style={{ fontSize: "28px", lineHeight: "34px", letterSpacing: "-0.02em", fontWeight: 500 }}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function ResponseBar({ attending, total }: { attending: number; total: number }) {
  const declined = Math.max(0, total - attending);
  const attendPct = total ? Math.round((attending / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-body text-ink-700">{attending.toLocaleString()} attending</span>
        <span className="text-mini text-ink-400 tabular-nums">{attendPct}%</span>
      </div>
      <div className="h-2 rounded-full bg-ink-100 overflow-hidden">
        <div
          className="h-full bg-signal-live transition-all duration-500"
          style={{ width: `${attendPct}%` }}
        />
      </div>
      <div className="flex items-baseline justify-between mt-3 text-mini text-ink-500">
        <span>{declined.toLocaleString()} declined</span>
      </div>
    </div>
  );
}

function ActivityRow({ event }: { event: ActivityRecord }) {
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
        <div className="text-mini text-ink-400 mt-0.5 tabular-nums">{shortFmt.format(event.createdAt)}</div>
      </div>
    </li>
  );
}

type UC = { id: string; name: string; venue: string | null; eventAt: Date | null };
function groupByDay(rows: UC[]): Map<string, UC[]> {
  const out = new Map<string, UC[]>();
  for (const r of rows) {
    if (!r.eventAt) continue;
    const key = dayFmt.format(r.eventAt);
    const arr = out.get(key) ?? [];
    arr.push(r);
    out.set(key, arr);
  }
  return out;
}
