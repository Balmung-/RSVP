import { prisma } from "./db";

export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "closed" | "deadline" | "rate_limited" | "invalid" };

export async function findInviteeByToken(token: string) {
  return prisma.invitee.findUnique({
    where: { rsvpToken: token },
    include: { campaign: true, response: true },
  });
}

export async function submitResponse(params: {
  token: string;
  attending: boolean;
  guestsCount?: number;
  message?: string;
  ip?: string;
  userAgent?: string;
}): Promise<SubmitResult> {
  if (!params.token || typeof params.token !== "string") return { ok: false, reason: "invalid" };
  const inv = await prisma.invitee.findUnique({
    where: { rsvpToken: params.token },
    include: { campaign: true },
  });
  if (!inv) return { ok: false, reason: "not_found" };
  const c = inv.campaign;
  if (c.status === "closed" || c.status === "archived") return { ok: false, reason: "closed" };
  if (c.rsvpDeadline && c.rsvpDeadline < new Date()) return { ok: false, reason: "deadline" };

  const guests = Math.max(0, Math.min(params.guestsCount ?? 0, inv.guestsAllowed));

  await prisma.response.upsert({
    where: { inviteeId: inv.id },
    create: {
      campaignId: c.id,
      inviteeId: inv.id,
      attending: params.attending,
      guestsCount: params.attending ? guests : 0,
      message: params.message?.slice(0, 2000) || null,
      ip: params.ip,
      userAgent: params.userAgent?.slice(0, 300),
    },
    update: {
      attending: params.attending,
      guestsCount: params.attending ? guests : 0,
      message: params.message?.slice(0, 2000) || null,
      respondedAt: new Date(),
    },
  });

  await prisma.eventLog.create({
    data: {
      kind: "rsvp.submitted",
      refType: "invitee",
      refId: inv.id,
      data: JSON.stringify({ attending: params.attending, guests: params.attending ? guests : 0 }),
    },
  });

  return { ok: true };
}
