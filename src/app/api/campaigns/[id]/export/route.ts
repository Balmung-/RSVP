import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthed()) return new NextResponse("Unauthorized", { status: 401 });
  const invitees = await prisma.invitee.findMany({
    where: { campaignId: params.id },
    include: { response: true },
    orderBy: { fullName: "asc" },
  });

  const rows = [
    ["full_name", "title", "organization", "email", "phone", "attending", "guests", "responded_at", "message"],
    ...invitees.map((i) => [
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
  ];
  const csv = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="campaign-${params.id}.csv"`,
    },
  });
}
