import { prisma } from "./db";

// Central rules for what we accept. Keep image MIME types tight (no SVG —
// SVG can contain script); PDFs + office docs for attachments.

export const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const DOC_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
]);

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_DOC_BYTES = 10 * 1024 * 1024;

export type UploadKind = "image" | "doc";

export function acceptForKind(kind: UploadKind): string {
  return kind === "image" ? Array.from(IMAGE_MIMES).join(",") : [...IMAGE_MIMES, ...DOC_MIMES].join(",");
}

export function validateUpload(file: { type: string; size: number }, kind: UploadKind): string | null {
  if (kind === "image") {
    if (!IMAGE_MIMES.has(file.type)) return "Image must be PNG, JPEG, WebP, or GIF.";
    if (file.size > MAX_IMAGE_BYTES) return "Image too large — limit is 4 MB.";
    return null;
  }
  if (!IMAGE_MIMES.has(file.type) && !DOC_MIMES.has(file.type)) {
    return "File type not supported.";
  }
  if (file.size > MAX_DOC_BYTES) return "File too large — limit is 10 MB.";
  return null;
}

export async function storeUpload(params: {
  filename: string;
  contentType: string;
  size: number;
  contents: Buffer;
  uploadedBy?: string | null;
}): Promise<{ id: string; url: string }> {
  const row = await prisma.fileUpload.create({
    data: {
      filename: params.filename.slice(0, 200),
      contentType: params.contentType,
      size: params.size,
      contents: params.contents,
      uploadedBy: params.uploadedBy ?? null,
    },
    select: { id: true },
  });
  return { id: row.id, url: `/api/files/${row.id}` };
}

export async function fetchUpload(id: string) {
  return prisma.fileUpload.findUnique({ where: { id } });
}
