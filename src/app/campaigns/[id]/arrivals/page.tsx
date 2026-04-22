import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ArrivalsBoard } from "@/components/ArrivalsBoard";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireActiveTenantId } from "@/lib/auth";
import { canSeeCampaignRow } from "@/lib/teams";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";

export default async function Arrivals({ params }: { params: { id: string } }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const tenantId = requireActiveTenantId(me);
  const campaign = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!campaign) notFound();
  if (!(await canSeeCampaignRow(me.id, hasRole(me, "admin"), tenantId, campaign.tenantId, campaign.teamId))) notFound();

  // Server-render the first paint so the board isn't empty on load. Later
  // updates are pulled by the client via the ETag-aware JSON endpoint.
  const [responses, agg, arrivedCount, arrivedGuestsAgg] = await Promise.all([
    prisma.response.findMany({
      where: { campaignId: params.id, attending: true },
      include: { invitee: { select: { fullName: true, title: true, organization: true, rsvpToken: true } } },
      orderBy: [{ checkedInAt: "desc" }, { respondedAt: "desc" }],
      take: 500,
    }),
    prisma.response.aggregate({
      where: { campaignId: params.id, attending: true },
      _sum: { guestsCount: true },
      _count: { _all: true },
      _max: { checkedInAt: true, respondedAt: true },
    }),
    prisma.response.count({ where: { campaignId: params.id, attending: true, checkedInAt: { not: null } } }),
    prisma.response.aggregate({
      where: { campaignId: params.id, attending: true, checkedInAt: { not: null } },
      _sum: { guestsCount: true },
    }),
  ]);

  const initial = {
    version: [
      agg._max.checkedInAt?.toISOString() ?? "",
      agg._max.respondedAt?.toISOString() ?? "",
      agg._count._all,
    ].join("|"),
    totals: {
      expected: agg._count._all,
      arrived: arrivedCount,
      pending: agg._count._all - arrivedCount,
      expectedGuests: agg._sum.guestsCount ?? 0,
      arrivedGuests: arrivedGuestsAgg._sum.guestsCount ?? 0,
    },
    rows: responses.map((r) => ({
      id: r.id,
      name: r.invitee.fullName,
      title: r.invitee.title,
      organization: r.invitee.organization,
      token: r.invitee.rsvpToken,
      guestsCount: r.guestsCount,
      checkedInAt: r.checkedInAt?.toISOString() ?? null,
    })),
  };

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
        <Link href={`/campaigns/${campaign.id}/roster`} className="btn-ghost">Print roster</Link>
      }
    >
      <ArrivalsBoard campaignId={campaign.id} initial={initial} tz={TZ} />
    </Shell>
  );
}
