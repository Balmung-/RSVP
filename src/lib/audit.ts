import { prisma } from "./db";
import { getCurrentUser } from "./auth";

// One place to write audit rows. Auto-populates actorId from the session when
// the caller is inside an admin context; leave actorId explicitly null for
// system / public flows (stage dispatcher, RSVP submission, webhooks).
//
// Audit writes never throw — a failed eventLog insert is annoying but must
// not break the business action it's reporting on.

export async function logAction(params: {
  kind: string;
  refType?: string;
  refId?: string;
  data?: unknown;
  actorId?: string | null;
}): Promise<void> {
  try {
    let actor: string | null;
    if (params.actorId === undefined) {
      const u = await getCurrentUser();
      actor = u?.id ?? null;
    } else {
      actor = params.actorId;
    }
    await prisma.eventLog.create({
      data: {
        kind: params.kind,
        refType: params.refType,
        refId: params.refId,
        actorId: actor,
        data: params.data ? JSON.stringify(params.data) : null,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[audit] logAction failed", { kind: params.kind, error: String(e).slice(0, 200) });
  }
}
