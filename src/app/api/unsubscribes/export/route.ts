import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPlatformRole } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { csvRow } from "@/lib/contact";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Admin-only audit export of everyone who opted out. Rows are in the
// same shape as the /unsubscribes list — one row per Unsubscribe.
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return new NextResponse("Unauthorized", { status: 401 });
  if (!hasPlatformRole(me, "admin")) return new NextResponse("Forbidden", { status: 403 });

  const rows = await prisma.unsubscribe.findMany({
    orderBy: { createdAt: "desc" },
    take: 50_000,
  });

  const header = ["channel", "address", "reason", "created_at"];
  const lines = [csvRow(header)];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.email ? "email" : "sms",
        r.email ?? r.phoneE164 ?? "",
        r.reason ?? "",
        r.createdAt.toISOString(),
      ]),
    );
  }

  await logAction({
    kind: "unsubscribes.export",
    refType: "export",
    data: { rows: rows.length },
    actorId: me.id,
  });

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="unsubscribes-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
