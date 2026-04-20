import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseTaqnyatWhatsAppDlr } from "@/lib/providers/taqnyat/webhooks";
import { handleTaqnyatDeliveryWebhook } from "../handler";

// P12 — Taqnyat WhatsApp delivery receipt webhook.
//
// Thin wrapper around the shared pure handler, same shape as the
// sibling SMS route. Differs only in the parser (Meta envelope vs
// flat JSON) and the `channel` audit tag.
//
// Expected Taqnyat config: point their WhatsApp webhook at
//   https://<host>/api/webhooks/taqnyat/delivery/whatsapp
// with the same TAQNYAT_WEBHOOK_SECRET bearer as the SMS webhook.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const { status, body } = await handleTaqnyatDeliveryWebhook(
    req,
    parseTaqnyatWhatsAppDlr,
    "whatsapp",
    {
      getSecret: () => process.env.TAQNYAT_WEBHOOK_SECRET,
      findInvitation: (providerId, channel) =>
        prisma.invitation.findFirst({
          where: { providerId, channel },
          select: { id: true, status: true, deliveredAt: true },
        }),
      updateInvitation: async (id, data) => {
        await prisma.invitation.update({
          where: { id },
          data,
        });
      },
      createEventLog: async (data) => {
        await prisma.eventLog.create({ data });
      },
      now: () => new Date(),
    },
  );
  return NextResponse.json(body, { status });
}
