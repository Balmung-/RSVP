import { NextResponse } from "next/server";
import { activeTenantIdOf, requireRole } from "@/lib/auth";
import { storeUpload, validateUpload } from "@/lib/uploads";
import { extractFromUpload } from "@/lib/ingest";
import { uploadsHandler } from "./handler";

// Thin wrapper around the pure `uploadsHandler`. Auth, validation,
// storage, and post-store extraction are coordinated in handler.ts
// — the route just injects the real dependencies and returns a
// NextResponse with the structured body.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const { status, body } = await uploadsHandler(req, {
    requireEditor: async () => {
      const me = await requireRole("editor");
      const tenantId = activeTenantIdOf(me);
      if (!tenantId) throw new Error("no_active_tenant");
      return { id: me.id, activeTenantId: tenantId };
    },
    readFormData: (r) => r.formData(),
    validateUpload,
    storeUpload,
    extractFromUpload,
  });
  return NextResponse.json(body, { status });
}
