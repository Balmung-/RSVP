import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// JSON search across campaigns + contacts. Used by the command palette.
// Keeps the result shape consistent so the UI can render them uniformly.

export async function GET(req: Request) {
  if (!(await isAuthed())) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q || q.length < 2) return NextResponse.json({ ok: true, results: [] });

  const [campaigns, contacts] = await Promise.all([
    prisma.campaign.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { venue: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, name: true, venue: true, status: true },
    }),
    prisma.contact.findMany({
      where: {
        archivedAt: null,
        OR: [
          { fullName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { organization: { contains: q, mode: "insensitive" } },
          { phoneE164: { contains: q } },
        ],
      },
      orderBy: { fullName: "asc" },
      take: 6,
      select: { id: true, fullName: true, organization: true, vipTier: true },
    }),
  ]);

  const results = [
    ...campaigns.map((c) => ({
      type: "campaign" as const,
      id: c.id,
      label: c.name,
      hint: [c.venue, c.status].filter(Boolean).join(" · "),
      href: `/campaigns/${c.id}`,
    })),
    ...contacts.map((c) => ({
      type: "contact" as const,
      id: c.id,
      label: c.fullName,
      hint: [c.organization, c.vipTier === "standard" ? null : c.vipTier].filter(Boolean).join(" · "),
      href: `/contacts/${c.id}/edit`,
    })),
  ];
  return NextResponse.json({ ok: true, results });
}
