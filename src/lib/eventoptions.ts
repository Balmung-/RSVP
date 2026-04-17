import { prisma } from "./db";

export type EventOptionInput = {
  label?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  venue?: string | null;
};

export async function listEventOptions(campaignId: string) {
  return prisma.eventOption.findMany({
    where: { campaignId },
    orderBy: [{ startsAt: "asc" }, { order: "asc" }],
  });
}

export async function createEventOption(campaignId: string, input: EventOptionInput) {
  const max = await prisma.eventOption.findFirst({
    where: { campaignId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  return prisma.eventOption.create({
    data: {
      campaignId,
      order: (max?.order ?? -1) + 1,
      label: input.label?.slice(0, 120) || null,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
      venue: input.venue?.slice(0, 200) || null,
    },
  });
}

export async function deleteEventOption(eventOptionId: string, campaignId: string) {
  await prisma.eventOption.deleteMany({ where: { id: eventOptionId, campaignId } });
}
