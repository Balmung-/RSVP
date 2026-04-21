import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { fetchUpload, isUploadPubliclyReferenced } from "@/lib/uploads";
import { handleFileDownload } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Mixed-visibility file endpoint.
//
// Public campaign assets (brand logo/hero + attachment URLs that point at
// `/api/files/{id}`) stay fetchable without auth so RSVP/email surfaces
// keep working. Everything else is private-by-default: the uploader can
// fetch it again, and admins can inspect/debug it, but a leaked cuid alone
// is no longer enough to read an arbitrary operator upload.

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const result = await handleFileDownload(params.id, {
    fetchUpload,
    getCurrentUser,
    isPublicFile: isUploadPubliclyReferenced,
  });
  if (result.status !== 200) return new NextResponse("Not Found", { status: 404 });
  return new NextResponse(Buffer.from(result.body), { headers: result.headers });
}
