import { NextResponse } from "next/server";
import { fetchUpload } from "@/lib/uploads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public file endpoint. The id is a cuid — unguessable enough for
// "semi-public" assets like logos and agenda PDFs attached to invitations.
// For stricter private files, gate on an auth check here.

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const row = await fetchUpload(params.id);
  if (!row) return new NextResponse("Not Found", { status: 404 });
  return new NextResponse(new Uint8Array(row.contents), {
    headers: {
      "Content-Type": row.contentType,
      "Content-Length": String(row.size),
      "Content-Disposition": `inline; filename="${row.filename.replace(/"/g, "")}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
