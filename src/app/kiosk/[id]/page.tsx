import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { canSeeCampaignRow } from "@/lib/teams";
import { KioskBoard } from "@/components/KioskBoard";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";

// Full-bleed door kiosk. No Shell, no sidebar, no controls — it's meant
// to run on a tablet mounted at the entrance. Admin sets it up once and
// leaves it. Polls the arrivals feed like the web board; chimes on
// each new arrival so the greeter hears confirmation.

export default async function KioskPage({ params }: { params: { id: string } }) {
  const me = await getCurrentUser();
  if (!me) redirect(`/login?returnTo=${encodeURIComponent(`/kiosk/${params.id}`)}`);

  const campaign = await prisma.campaign.findUnique({
    where: { id: params.id },
    select: { id: true, name: true, status: true, teamId: true },
  });
  if (!campaign) notFound();
  if (!(await canSeeCampaignRow(me.id, hasRole(me, "admin"), campaign.teamId))) notFound();

  const [responses, agg, arrivedCount, arrivedGuestsAgg] = await Promise.all([
    prisma.response.findMany({
      where: { campaignId: params.id, attending: true },
      include: { invitee: { select: { fullName: true, title: true, organization: true, rsvpToken: true } } },
      orderBy: [{ checkedInAt: "desc" }, { respondedAt: "desc" }],
      take: 50,
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
    <KioskBoard
      campaignId={campaign.id}
      campaignName={campaign.name}
      initial={initial}
      tz={TZ}
    />
  );
}
