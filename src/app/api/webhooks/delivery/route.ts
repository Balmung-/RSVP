import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Inbound delivery status from providers. Normalizes to our invitation.status.
// Requires WEBHOOK_SIGNING_SECRET to be set; caller supplies HMAC-SHA256 of the
// raw body in the `x-signature` header (hex). Each provider's own webhook is
// wrapped by a small shim that re-signs with our secret.

const ALLOWED_STATUS = new Set(["delivered", "failed", "bounced"]);

type Payload = {
  providerId: unknown;
  status: unknown;
  error?: unknown;
};

export async function POST(req: Request) {
  const secret = process.env.WEBHOOK_SIGNING_SECRET;
  const raw = await req.text();

  if (!secret) return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });

  const sig = req.headers.get("x-signature") ?? "";
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  let body: Payload;
  try {
    body = JSON.parse(raw) as Payload;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const providerId = typeof body.providerId === "string" ? body.providerId : "";
  const status = typeof body.status === "string" ? body.status : "";
  const error = typeof body.error === "string" ? body.error.slice(0, 500) : null;

  if (!providerId || !ALLOWED_STATUS.has(status)) {
    return NextResponse.json({ ok: false, error: "bad_payload" }, { status: 400 });
  }

  const inv = await prisma.invitation.findFirst({ where: { providerId } });
  if (!inv) return NextResponse.json({ ok: true, noted: "unknown_id" });

  await prisma.invitation.update({
    where: { id: inv.id },
    data: {
      status,
      error,
      deliveredAt: status === "delivered" ? new Date() : inv.deliveredAt,
    },
  });
  await prisma.eventLog.create({
    data: {
      kind: `invite.${status}`,
      refType: "invitation",
      refId: inv.id,
      data: JSON.stringify({ providerId, status, error }),
    },
  });
  return NextResponse.json({ ok: true });
}
