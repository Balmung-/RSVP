import Link from "next/link";
import { redirect } from "next/navigation";
import type { Campaign } from "@prisma/client";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { campaignStats } from "@/lib/campaigns";
import {
  readAdminLocale,
  readAdminCalendar,
  adminDict,
  formatAdminDate,
  type AdminLocale,
  type AdminCalendar,
} from "@/lib/adminLocale";

type Stats = Awaited<ReturnType<typeof campaignStats>>;
type ListRow = { c: Campaign; stats: Stats };

export const dynamic = "force-dynamic";

const statusColor: Record<string, string> = {
  draft: "bg-ink-300",
  active: "bg-signal-live",
  sending: "bg-signal-hold animate-pulse",
  closed: "bg-ink-400",
  archived: "bg-ink-300",
};

export default async function CampaignsPage() {
  if (!(await isAuthed())) redirect("/login");
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();
  const T = adminDict(locale);

  const campaigns = await prisma.campaign.findMany({
    orderBy: [{ status: "asc" }, { eventAt: "asc" }, { createdAt: "desc" }],
  });

  const rows = await Promise.all(
    campaigns.map(async (c) => ({ c, stats: await campaignStats(c.id) })),
  );

  const upcoming = rows.filter((r) => ["draft", "active", "sending"].includes(r.c.status));
  const past = rows.filter((r) => ["closed", "archived"].includes(r.c.status));

  return (
    <Shell
      title={T.campaigns}
      actions={
        <Link href="/campaigns/new" className="btn btn-primary">
          <Icon name="plus" size={14} />
          {T.newCampaign}
        </Link>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon="calendar-check"
          title={T.noCampaignsYet}
          action={{
            label: locale === "ar" ? "أنشئ أول حملة" : "Create the first campaign",
            href: "/campaigns/new",
          }}
        >
          {locale === "ar"
            ? "الحملة هي فعالية واحدة بقائمة ضيوف واحدة ونافذة واحدة لاستقبال الردود. كل شيء آخر — الاستيراد والجدولة والأسئلة والحضور — يعيش داخلها."
            : "A campaign is one event, one guest list, one window to collect responses. Everything else — imports, scheduling, questions, arrivals — lives inside it."}
        </EmptyState>
      ) : (
        <div className="max-w-5xl">
          {upcoming.length > 0 ? (
            <CampaignList
              label={T.active}
              rows={upcoming}
              T={T}
              locale={locale}
              calendar={calendar}
            />
          ) : null}
          {past.length > 0 ? (
            <div className={upcoming.length > 0 ? "mt-16" : ""}>
              <CampaignList
                label={locale === "ar" ? "سابقة" : "Past"}
                rows={past}
                T={T}
                locale={locale}
                calendar={calendar}
                muted
              />
            </div>
          ) : null}
        </div>
      )}
    </Shell>
  );
}

function CampaignList({
  label,
  rows,
  T,
  locale,
  calendar,
  muted,
}: {
  label: string;
  rows: ListRow[];
  T: ReturnType<typeof adminDict>;
  locale: AdminLocale;
  calendar: AdminCalendar;
  muted?: boolean;
}) {
  return (
    <section>
      <h2 className="text-micro uppercase text-ink-400 mb-4">{label}</h2>
      <ul className="flex flex-col">
        {rows.map(({ c, stats }) => (
          <li key={c.id}>
            <Link
              href={`/campaigns/${c.id}`}
              className={`flex items-center gap-6 -mx-4 px-4 py-5 rounded-xl transition-colors ${muted ? "hover:bg-ink-100/60" : "hover:bg-ink-100"}`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusColor[c.status] ?? "bg-ink-300"}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className={`text-sub truncate ${muted ? "text-ink-600" : "text-ink-900"}`}>
                  {c.name}
                </div>
                <div className="text-mini text-ink-400 mt-0.5 tabular-nums">
                  {c.venue ? <>{c.venue}</> : null}
                  {c.venue && c.eventAt ? <span className="mx-1.5 text-ink-300">·</span> : null}
                  {c.eventAt ? <>{formatAdminDate(c.eventAt, locale, calendar, { dateStyle: "medium", timeStyle: "short" })}</> : null}
                  {!c.venue && !c.eventAt ? <>{locale === "ar" ? "لا تاريخ محدد" : "No date set"}</> : null}
                </div>
              </div>
              <div className="hidden md:grid grid-cols-3 gap-10 tabular-nums shrink-0">
                <Mini label={T.invited} value={stats.total} />
                <Mini
                  label={T.responded}
                  value={stats.total ? `${stats.responded} / ${stats.total}` : "—"}
                />
                <Mini label={T.headcount} value={stats.headcount} emphasize />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Mini({ label, value, emphasize }: { label: string; value: number | string; emphasize?: boolean }) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-[10px] uppercase tracking-wider text-ink-400">{label}</span>
      <span className={`text-body mt-0.5 ${emphasize ? "text-ink-900 font-medium" : "text-ink-600"}`}>
        {value}
      </span>
    </div>
  );
}
