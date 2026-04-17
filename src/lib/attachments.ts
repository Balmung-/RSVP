import { prisma } from "./db";

export const ATTACHMENT_KINDS = ["file", "map", "agenda", "parking"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export type AttachmentInput = {
  label: string;
  url: string;
  kind: AttachmentKind;
};

// URL-only for now; hosting is the tenant's problem (S3, gov doc server).
// We validate the URL is http(s) and reasonably sized; rendered as a link on
// the RSVP page and optionally embedded in emails.

export function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && raw.length <= 2000;
  } catch {
    return false;
  }
}

export async function listAttachments(campaignId: string) {
  return prisma.campaignAttachment.findMany({
    where: { campaignId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
}

export async function createAttachment(campaignId: string, input: AttachmentInput) {
  if (!isSafeUrl(input.url)) throw new Error("invalid_url");
  const max = await prisma.campaignAttachment.findFirst({
    where: { campaignId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  return prisma.campaignAttachment.create({
    data: {
      campaignId,
      order: (max?.order ?? -1) + 1,
      label: input.label.slice(0, 120),
      url: input.url,
      kind: input.kind,
    },
  });
}

export async function deleteAttachment(attachmentId: string, campaignId: string) {
  await prisma.campaignAttachment.deleteMany({ where: { id: attachmentId, campaignId } });
}
