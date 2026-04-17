import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Stat } from "@/components/Stat";
import { Badge } from "@/components/Badge";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: undefined, timeStyle: "short", timeZone: TZ });

export default async function Arrivals({ params }: { params: { id: string } }) {
  if (!(await isAuthed())) redirect("/login");
  const campaign = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!campaign) notFound();

  const [responses, expected, arrived, arrivedGuests] = await Promise.all([
    prisma.response.findMany({
      where: { campaignId: params.id, attending: true },
      include: { invitee: true },
      orderBy: [{ checkedInAt: "desc" }, { respondedAt: "desc" }],
    }),
    prisma.response.count({ where: { campaignId: params.id, attending: true } }),
    prisma.response.count({ where: { campaignId: params.id, attending: true, checkedInAt: { not: null } } }),
    prisma.response.aggregate({
      where: { campaignId: params.id, attending: true, checkedInAt: { not: null } },
      _sum: { guestsCount: true },
    }),
  ]);

  const arrivedGuestsSum = arrivedGuests._sum.guestsCount ?? 0;
  const pending = expected - arrived;
  const expectedGuests = responses.reduce((s, r) => s + r.guestsCount, 0);
  const totalExpected = expected + expectedGuests;
  const totalArrived = arrived + arrivedGuestsSum;

  return (
    <Shell
      title={`Arrivals — ${campaign.name}`}
      crumb={
        <span>
          <Link href={`/campaigns/${campaign.id}`} className="hover:underline">{campaign.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Arrivals</span>
        </span>
      }
      actions={
        <>
          <Link href={`/campaigns/${campaign.id}/roster`} className="btn-ghost">Print roster</Link>
        </>
      }
    >
      <meta httpEquiv="refresh" content="15" />

      <div className="grid grid-cols-5 gap-8 mb-10">
        <Stat label="Expected" value={expected} />
        <Stat label="Arrived" value={arrived} hint={expected ? `${Math.round((arrived / expected) * 100)}%` : ""} />
        <Stat label="Pending" value={pending} />
        <Stat label="Guests arrived" value={arrivedGuestsSum} />
        <Stat label="Headcount" value={totalArrived} hint={`/ ${totalExpected}`} />
      </div>

      <div className="panel rail overflow-hidden">
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Organization</th>
              <th scope="col">Guests</th>
              <th scope="col">Status</th>
              <th scope="col" className="text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            {responses.map((r) => {
              const inIn = !!r.checkedInAt;
              return (
                <tr key={r.id}>
                  <td>
                    <Link
                      href={`/checkin/${r.invitee.rsvpToken}`}
                      className="font-medium text-ink-900 hover:underline"
                    >
                      {r.invitee.fullName}
                    </Link>
                    {r.invitee.title ? (
                      <div className="text-xs text-ink-400 mt-0.5">{r.invitee.title}</div>
                    ) : null}
                  </td>
                  <td className="text-ink-600">{r.invitee.organization ?? <span className="text-ink-300">—</span>}</td>
                  <td className="text-ink-600 tabular-nums">
                    {r.guestsCount > 0 ? `+ ${r.guestsCount}` : <span className="text-ink-300">—</span>}
                  </td>
                  <td>
                    <Badge tone={inIn ? "live" : "hold"}>{inIn ? "arrived" : "expected"}</Badge>
                  </td>
                  <td className="text-right tabular-nums text-xs text-ink-600">
                    {inIn && r.checkedInAt ? fmt.format(r.checkedInAt) : <span className="text-ink-300">—</span>}
                  </td>
                </tr>
              );
            })}
            {responses.length === 0 ? (
              <tr><td colSpan={5} className="py-16 text-center text-ink-400 text-sm">No confirmed attendees yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink-400 mt-4">Auto-refreshes every 15s.</p>
    </Shell>
  );
}
