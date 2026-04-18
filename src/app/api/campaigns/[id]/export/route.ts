import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { csvRow } from "@/lib/contact";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  // Full PII dump — gate on editor. Viewers see responses in the workspace
  // but can't walk out with the spreadsheet.
  const me = await getCurrentUser();
  if (!me) return new NextResponse("Unauthorized", { status: 401 });
  if (!hasRole(me, "editor")) return new NextResponse("Forbidden", { status: 403 });

  const campaign = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!campaign) return new NextResponse("Not Found", { status: 404 });

  const invitees = await prisma.invitee.findMany({
    where: { campaignId: params.id },
    include: { response: true },
    orderBy: { fullName: "asc" },
  });

  const header = ["full_name", "title", "organization", "email", "phone", "attending", "guests", "responded_at", "message"];
  const lines = [csvRow(header)];
  for (const i of invitees) {
    lines.push(
      csvRow([
        i.fullName,
        i.title ?? "",
        i.organization ?? "",
        i.email ?? "",
        i.phoneE164 ?? "",
        i.response ? (i.response.attending ? "yes" : "no") : "pending",
        i.response?.attending ? i.response.guestsCount : 0,
        i.response?.respondedAt?.toISOString() ?? "",
        (i.response?.message ?? "").replace(/\r?\n/g, " "),
      ]),
    );
  }

  await logAction({
    kind: "campaign.export",
    refType: "campaign",
    refId: params.id,
    data: { rows: invitees.length },
    actorId: me.id,
  });

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="campaign-${params.id}.csv"`,
    },
  });
}
