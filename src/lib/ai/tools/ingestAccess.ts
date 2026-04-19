import type { Prisma } from "@prisma/client";

// P6-fix — shared ownership gate for file-backed tools.
//
// Both `summarize_file` and `review_file_import` accept a raw
// `ingestId` and read the ingest's extracted text. Without this gate
// any authenticated operator who learned another user's ingestId
// (say, from a shared transcript) could pull that user's file
// contents. The gate enforces that non-admins can only reach ingests
// tied to FileUpload rows THEY uploaded; admins bypass and see
// everything.
//
// Composed as a `findFirst` where-clause rather than a post-fetch
// check so a wrong-owner hit returns "not found" identically to a
// genuinely-missing id — no side-channel for probing which ids
// belong to which operator.
//
// Kept as a pure helper so the ownership policy is testable in
// isolation without standing up Prisma, and so a future tool that
// also joins through FileUpload can reuse the same clause verbatim
// instead of redefining it.

export type IngestAccessCtx = {
  user: { id: string };
  isAdmin: boolean;
};

export function buildIngestOwnershipWhere(
  ingestId: string,
  ctx: IngestAccessCtx,
): Prisma.FileIngestWhereInput {
  if (ctx.isAdmin) {
    return { id: ingestId };
  }
  return {
    id: ingestId,
    fileUpload: { uploadedBy: ctx.user.id },
  };
}
