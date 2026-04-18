import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { canSeeCampaign } from "@/lib/teams";
import { buildArrivalsFeed } from "@/lib/arrivals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// JSON feed for the client-polled arrivals board. ETag-aware: the
// version key comes out of buildArrivalsFeed — idle tabs get a cheap
// 304 and never decode a payload. Feed shape is defined once in
// lib/arrivals and shared with the workspace tab + kiosk.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!(await canSeeCampaign(me.id, hasRole(me, "admin"), params.id))) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Cheap aggregate to build the ETag without touching the row set.
  // When nothing has changed we can respond 304 without the expensive
  // findMany + joins.
  const agg = await prisma.response.aggregate({
    where: { campaignId: params.id, attending: true },
    _max: { checkedInAt: true, respondedAt: true },
    _count: { _all: true },
  });
  const version = [
    agg._max.checkedInAt?.toISOString() ?? "",
    agg._max.respondedAt?.toISOString() ?? "",
    agg._count._all,
  ].join("|");
  const etag = `W/"arrivals-${params.id}-${Buffer.from(version).toString("base64url")}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  const body = await buildArrivalsFeed(params.id);
  return NextResponse.json(body, {
    headers: { ETag: etag, "Cache-Control": "private, must-revalidate" },
  });
}
