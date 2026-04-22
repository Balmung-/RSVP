import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireActiveTenantId } from "@/lib/auth";
import { canSeeCampaignRow } from "@/lib/teams";
import { buildArrivalsFeed } from "@/lib/arrivals";
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
  const tenantId = requireActiveTenantId(me);

  const campaign = await prisma.campaign.findUnique({
    where: { id: params.id },
    select: { id: true, name: true, status: true, tenantId: true, teamId: true },
  });
  if (!campaign) notFound();
  if (!(await canSeeCampaignRow(me.id, hasRole(me, "admin"), tenantId, campaign.tenantId, campaign.teamId))) notFound();

  // Kiosk tablets sit at the door, 50 rows is plenty on screen.
  const initial = await buildArrivalsFeed(params.id, { take: 50 });

  return (
    <KioskBoard
      campaignId={campaign.id}
      campaignName={campaign.name}
      initial={initial}
      tz={TZ}
    />
  );
}
