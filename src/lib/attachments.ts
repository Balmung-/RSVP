import { prisma } from "./db";
import type { CampaignAttachment } from "@prisma/client";

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
  const s = raw.trim();
  if (!s || s.length > 2000) return false;
  // Same-origin path (e.g. /api/files/<id> from our own upload endpoint).
  if (s.startsWith("/") && !s.startsWith("//")) return true;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// Trimming wrapper for form inputs — returns the cleaned URL on pass,
// null on fail. Accepts a tighter max (brand URLs shouldn't be 2KB) so
// the two previous duplicate local `safeUrl` helpers on the campaign
// new/edit pages can call into one place.
export function safeBrandUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 500) return null;
  return isSafeUrl(s) ? s : null;
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
  // If the attachment points at one of our FileUpload rows AND nothing
  // else references that URL, drop the bytes too. Prevents storage from
  // leaking over time as attachments come and go.
  //
  // Order matters: we check for other references *before* deleting so
  // the row-we're-about-to-delete is excluded via `excludeAttachmentId`
  // — running the reference check after the delete would treat a
  // concurrent insert by another admin as a new orphan and destroy
  // their fresh file. Not transactional, but tight enough.
  const att = await prisma.campaignAttachment.findFirst({
    where: { id: attachmentId, campaignId },
    select: { url: true },
  });
  if (!att) {
    await prisma.campaignAttachment.deleteMany({ where: { id: attachmentId, campaignId } });
    return;
  }

  const fileId = extractFileId(att.url);
  if (!fileId) {
    await prisma.campaignAttachment.deleteMany({ where: { id: attachmentId, campaignId } });
    return;
  }

  const stillReferenced = await anyUrlReferencesFile(fileId, { excludeAttachmentId: attachmentId });
  await prisma.campaignAttachment.deleteMany({ where: { id: attachmentId, campaignId } });
  if (!stillReferenced) {
    await prisma.fileUpload.deleteMany({ where: { id: fileId } }).catch(() => undefined);
  }
}

// Turn /api/files/<cuid> (with optional trailing slash / qs) into <cuid>.
// Returns null for anything that isn't a same-origin reference to our store.
export function extractFileId(url: string): string | null {
  const m = url.match(/^\/api\/files\/([a-z0-9]{16,})$/i);
  return m ? m[1] : null;
}

async function anyUrlReferencesFile(
  fileId: string,
  opts: { excludeAttachmentId?: string } = {},
): Promise<boolean> {
  const needle = `/api/files/${fileId}`;
  const [attCount, campaignCount] = await Promise.all([
    prisma.campaignAttachment.count({
      where: {
        url: needle,
        ...(opts.excludeAttachmentId ? { NOT: { id: opts.excludeAttachmentId } } : {}),
      },
    }),
    prisma.campaign.count({
      where: {
        OR: [
          { brandLogoUrl: needle },
          { brandHeroUrl: needle },
        ],
      },
    }),
  ]);
  return attCount > 0 || campaignCount > 0;
}

// Decorate attachments with FileUpload metadata (filename, size, contentType,
// uploadedAt) when they point at /api/files/<id>. External URLs come back
// as-is with `file: null`. Single batched query keeps the workspace fast.
export type HydratedAttachment = CampaignAttachment & {
  file: { filename: string; size: number; contentType: string; createdAt: Date } | null;
};

export async function hydrateAttachments(
  attachments: CampaignAttachment[],
): Promise<HydratedAttachment[]> {
  const ids: string[] = [];
  for (const a of attachments) {
    const id = extractFileId(a.url);
    if (id) ids.push(id);
  }
  if (ids.length === 0) {
    return attachments.map((a) => ({ ...a, file: null }));
  }
  const files = await prisma.fileUpload.findMany({
    where: { id: { in: ids } },
    select: { id: true, filename: true, size: true, contentType: true, createdAt: true },
  });
  const byId = new Map(files.map((f) => [f.id, f]));
  return attachments.map((a) => {
    const id = extractFileId(a.url);
    const f = id ? byId.get(id) : undefined;
    return {
      ...a,
      file: f ? { filename: f.filename, size: f.size, contentType: f.contentType, createdAt: f.createdAt } : null,
    };
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
