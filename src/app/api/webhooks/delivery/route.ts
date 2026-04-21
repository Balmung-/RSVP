import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handleGenericDeliveryWebhook } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Inbound delivery status from providers (SendGrid / Resend / Twilio
// / anything that re-signs with WEBHOOK_SIGNING_SECRET). Normalizes
// to Invitation.status.
//
// Thin wrapper around the shared pure handler. All decision logic
// (HMAC, parse, state transition, idempotency) lives in handler.ts
// where it's covered by unit tests without an RSC runtime or real
// Prisma. This file's only job is to inject the real deps.
//
// Each relay shim signs the raw body with HMAC-SHA256 and puts the
// hex digest in `x-signature`. The payload shape is:
//
//   { providerId: string,
//     channel:    "email" | "sms" | "whatsapp",   // REQUIRED
//     status:     "delivered" | "failed" | "bounced",
//     error?:     string }
//
// `channel` is what the send path wrote to Invitation.channel
// (NOT the provider-namespaced audit tag like "taqnyat-sms"). The
// relay shim is responsible for knowing which channel it's wrapping
// and placing that value in the payload.

export async function POST(req: Request) {
  const result = await handleGenericDeliveryWebhook(req, {
    getSecret: () => process.env.WEBHOOK_SIGNING_SECRET,
    findInvitation: (providerId, channel) =>
      prisma.invitation.findFirst({
        where: { providerId, channel },
        select: { id: true, status: true, deliveredAt: true },
      }),
    updateInvitation: async (id, data) => {
      await prisma.invitation.update({ where: { id }, data });
    },
    createEventLog: async (data) => {
      await prisma.eventLog.create({ data });
    },
    now: () => new Date(),
  });
  return NextResponse.json(result.body, { status: result.status });
}
