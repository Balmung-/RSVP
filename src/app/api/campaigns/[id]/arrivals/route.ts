import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// JSON feed for the client-polled arrivals board. ETag-aware: the version
// key is max(updatedAt|respondedAt|checkedInAt) for confirmed attendees —
// idle tabs get a cheap 304 and never decode a payload.

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!(await isAuthed())) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const agg = await prisma.response.aggregate({
    where: { campaignId: params.id, attending: true },
    _max: { checkedInAt: true, respondedAt: true },
    _sum: { guestsCount: true },
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

  const [responses, arrivedCount, arrivedGuestsSum] = await Promise.all([
    prisma.response.findMany({
      where: { campaignId: params.id, attending: true },
      include: { invitee: { select: { fullName: true, title: true, organization: true, rsvpToken: true } } },
      orderBy: [{ checkedInAt: "desc" }, { respondedAt: "desc" }],
      take: 500,
    }),
    prisma.response.count({ where: { campaignId: params.id, attending: true, checkedInAt: { not: null } } }),
    prisma.response.aggregate({
      where: { campaignId: params.id, attending: true, checkedInAt: { not: null } },
      _sum: { guestsCount: true },
    }),
  ]);

  const body = {
    version,
    totals: {
      expected: agg._count._all,
      arrived: arrivedCount,
      pending: agg._count._all - arrivedCount,
      expectedGuests: agg._sum.guestsCount ?? 0,
      arrivedGuests: arrivedGuestsSum._sum.guestsCount ?? 0,
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

  return NextResponse.json(body, { headers: { ETag: etag, "Cache-Control": "private, must-revalidate" } });
}
