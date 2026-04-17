import { prisma } from "./db";

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
}) {
  const inv = await prisma.invitee.findUnique({
    where: { rsvpToken: params.token },
    include: { campaign: true },
  });
  if (!inv) return { ok: false as const, reason: "not_found" };
  const c = inv.campaign;
  if (c.status === "closed" || c.status === "archived") return { ok: false as const, reason: "closed" };
  if (c.rsvpDeadline && c.rsvpDeadline < new Date()) return { ok: false as const, reason: "deadline" };

  const guests = Math.max(0, Math.min(params.guestsCount ?? 0, inv.guestsAllowed));

  const response = await prisma.response.upsert({
    where: { inviteeId: inv.id },
    create: {
      campaignId: c.id,
      inviteeId: inv.id,
      attending: params.attending,
      guestsCount: params.attending ? guests : 0,
      message: params.message?.slice(0, 2000),
      ip: params.ip,
      userAgent: params.userAgent?.slice(0, 300),
    },
    update: {
      attending: params.attending,
      guestsCount: params.attending ? guests : 0,
      message: params.message?.slice(0, 2000),
      respondedAt: new Date(),
    },
  });

  await prisma.eventLog.create({
    data: {
      kind: "rsvp.submitted",
      refType: "invitee",
      refId: inv.id,
      data: JSON.stringify({ attending: response.attending, guests: response.guestsCount }),
    },
  });

  return { ok: true as const, response };
}
