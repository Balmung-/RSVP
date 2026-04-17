import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Inbound delivery status from providers. Normalizes to our invitation.status vocab.
// Wire each provider's webhook URL to here; sign verification is left provider-specific.

type Payload = {
  providerId: string;
  status: "delivered" | "failed" | "bounced";
  error?: string;
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Payload | null;
  if (!body?.providerId || !body.status) return NextResponse.json({ ok: false }, { status: 400 });

  const inv = await prisma.invitation.findFirst({ where: { providerId: body.providerId } });
  if (!inv) return NextResponse.json({ ok: true, noted: "unknown_id" });

  await prisma.invitation.update({
    where: { id: inv.id },
    data: {
      status: body.status,
      error: body.error ?? null,
      deliveredAt: body.status === "delivered" ? new Date() : inv.deliveredAt,
    },
  });
  await prisma.eventLog.create({
    data: {
      kind: `invite.${body.status}`,
      refType: "invitation",
      refId: inv.id,
      data: JSON.stringify(body),
    },
  });
  return NextResponse.json({ ok: true });
}
