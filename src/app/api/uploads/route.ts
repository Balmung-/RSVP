import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { storeUpload, validateUpload, type UploadKind } from "@/lib/uploads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Multipart upload endpoint. Editor role required. The `kind` field
// determines accepted MIME types + size ceilings.

export async function POST(req: Request) {
  const me = await requireRole("editor");
  const form = await req.formData();
  const file = form.get("file");
  const kindRaw = String(form.get("kind") ?? "image");
  const kind: UploadKind = kindRaw === "doc" ? "doc" : "image";

  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "no_file" }, { status: 400 });
  }
  const err = validateUpload({ type: file.type, size: file.size }, kind);
  if (err) return NextResponse.json({ ok: false, error: err }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const saved = await storeUpload({
    filename: file.name || "upload",
    contentType: file.type,
    size: file.size,
    contents: buf,
    uploadedBy: me.id,
  });
  return NextResponse.json({ ok: true, id: saved.id, url: saved.url });
}
