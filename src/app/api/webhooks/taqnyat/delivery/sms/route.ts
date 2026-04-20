import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseTaqnyatSmsDlr } from "@/lib/providers/taqnyat/webhooks";
import { handleTaqnyatDeliveryWebhook } from "../handler";

// P12 — Taqnyat SMS delivery receipt webhook.
//
// Thin wrapper around the shared pure handler. All decision logic
// (auth, parse, state transition, idempotency) lives in handler.ts
// where it's covered by unit tests without an RSC runtime or real
// Prisma. This file's only job is to inject the real deps.
//
// Expected Taqnyat config: point their SMS DLR webhook at
//   https://<host>/api/webhooks/taqnyat/delivery/sms
// and set either:
//   - Authorization: Bearer <TAQNYAT_WEBHOOK_SECRET>, or
//   - x-taqnyat-secret: <TAQNYAT_WEBHOOK_SECRET>
// The handler accepts either; use whichever their webhook form
// supports.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const { status, body } = await handleTaqnyatDeliveryWebhook(
    req,
    parseTaqnyatSmsDlr,
    "sms",
    {
      getSecret: () => process.env.TAQNYAT_WEBHOOK_SECRET,
      findInvitation: (providerId) =>
        prisma.invitation.findFirst({
          where: { providerId },
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
