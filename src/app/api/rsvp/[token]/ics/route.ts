import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { renderIcs, eventWindowForCampaign } from "@/lib/ics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public endpoint — token is the access control. Returns a single-event
// .ics the invitee can add to Outlook / Apple / Google calendar.
// Only emits when the invitee has RSVP'd attending (so declined folks
// don't accidentally get a calendar hold).

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const invitee = await prisma.invitee.findUnique({
    where: { rsvpToken: params.token },
    include: {
      campaign: true,
      response: { include: { eventOption: true } },
    },
  });
  // Uniform 404 for any non-emittable state — invalid token, declined,
  // no event time set. Otherwise "valid token, wrong state" responds
  // differently (409) from "invalid token" (404) and becomes a token
  // enumeration oracle.
  if (!invitee) return new NextResponse("Not Found", { status: 404 });
  if (!invitee.response?.attending) return new NextResponse("Not Found", { status: 404 });
  const window = eventWindowForCampaign(invitee.campaign, invitee.response.eventOption);
  if (!window) return new NextResponse("Not Found", { status: 404 });

  const description =
    (invitee.campaign.description ?? "") +
    (invitee.campaign.description ? "\n\n" : "") +
    `Your admission code: ${process.env.APP_URL ?? ""}/checkin/${invitee.rsvpToken}`;

  const ics = renderIcs({
    uid: `${invitee.id}@${(process.env.APP_URL ?? "einai").replace(/^https?:\/\//, "")}`,
    campaign: invitee.campaign,
    start: window.start,
    end: window.end,
    location: invitee.response.eventOption?.venue ?? invitee.campaign.venue ?? null,
    description,
  });

  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFilename(invitee.campaign.name)}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}

function safeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9\-_. ]/g, "-").slice(0, 80);
}
