import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { applyUnsubscribe } from "@/lib/inbound";
import { logAction } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Humans following the link in List-Unsubscribe (older clients, or
// clients that prefer GET) land on the confirmation page. Mail clients
// POSTing with the One-Click marker are handled below.
export async function GET(_req: Request, { params }: { params: { token: string } }) {
  return NextResponse.redirect(
    new URL(`/unsubscribe/${params.token}`, process.env.APP_URL ?? "http://localhost:3000"),
    302,
  );
}

// RFC 8058 one-click List-Unsubscribe. Mail clients like Gmail surface
// an "Unsubscribe" button next to the sender; clicking it POSTs here
// with `List-Unsubscribe=One-Click` in the body. No confirmation
// screen, no session — the RSVP token in the URL is the auth.
//
// We reject if the body doesn't carry the One-Click marker so a
// curious crawler GET-ing and POST-ing can't accidentally opt anyone
// out. Rate-of-error is irrelevant; opaque clients treat 200 the same
// as 204, so we always send 200 on hit-or-miss to keep retries quiet.
export async function POST(req: Request, { params }: { params: { token: string } }) {
  const ct = req.headers.get("content-type") ?? "";
  let oneClick = false;
  try {
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const fd = await req.formData();
      oneClick = String(fd.get("List-Unsubscribe") ?? "").trim() === "One-Click";
    } else {
      const raw = await req.text();
      oneClick = raw.includes("List-Unsubscribe=One-Click");
    }
  } catch {
    oneClick = false;
  }
  if (!oneClick) {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const invitee = await prisma.invitee.findUnique({
    where: { rsvpToken: params.token },
    select: { id: true, email: true, phoneE164: true },
  });
  if (!invitee) {
    return new NextResponse(null, { status: 200 });
  }

  if (invitee.email) await applyUnsubscribe("email", invitee.email, "one_click");
  if (invitee.phoneE164) await applyUnsubscribe("sms", invitee.phoneE164, "one_click");
  await logAction({
    kind: "unsubscribe.one_click",
    refType: "invitee",
    refId: invitee.id,
    actorId: null,
  });

  return new NextResponse(null, { status: 200 });
}
