import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Badge } from "@/components/Badge";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { campaignStats } from "@/lib/campaigns";

export const dynamic = "force-dynamic";

const statusTone = {
  draft: "wait",
  active: "live",
  sending: "hold",
  closed: "muted",
  archived: "muted",
} as const;

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const dateFmt = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TZ,
});

export default async function CampaignsPage() {
  if (!isAuthed()) redirect("/login");

  const campaigns = await prisma.campaign.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  const rows = await Promise.all(
    campaigns.map(async (c) => ({ c, stats: await campaignStats(c.id) })),
  );

  return (
    <Shell
      title="Campaigns"
      actions={
        <Link href="/campaigns/new" className="btn-primary">
          New campaign
        </Link>
      }
    >
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="panel rail overflow-hidden">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Event</th>
                <th scope="col" className="text-right">Invited</th>
                <th scope="col" className="text-right">Responded</th>
                <th scope="col" className="text-right">Attending</th>
                <th scope="col" className="text-right">Headcount</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, stats }) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/campaigns/${c.id}`} className="font-medium text-ink-900 hover:underline">
                      {c.name}
                    </Link>
                    {c.venue ? <div className="text-xs text-ink-400 mt-0.5">{c.venue}</div> : null}
                  </td>
                  <td className="text-ink-600 tabular-nums">
                    {c.eventAt ? dateFmt.format(c.eventAt) : "—"}
                  </td>
                  <td className="text-right tabular-nums">{stats.total}</td>
                  <td className="text-right tabular-nums text-ink-700">
                    {stats.responded}
                    <span className="text-ink-400"> / {stats.total}</span>
                  </td>
                  <td className="text-right tabular-nums">{stats.attending}</td>
                  <td className="text-right tabular-nums font-medium">{stats.headcount}</td>
                  <td>
                    <Badge tone={statusTone[c.status as keyof typeof statusTone] ?? "muted"}>{c.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}

function Empty() {
  return (
    <div className="panel flex flex-col items-center justify-center py-24 text-center">
      <div className="h-1.5 w-1.5 rounded-full bg-ink-900 mb-6" />
      <h2 className="text-lg font-medium tracking-tight">No campaigns yet</h2>
      <p className="text-sm text-ink-500 mt-2 max-w-sm">
        A campaign is one event, one guest list, one window to collect responses.
      </p>
      <Link href="/campaigns/new" className="btn-primary mt-8">
        Create the first campaign
      </Link>
    </div>
  );
}
