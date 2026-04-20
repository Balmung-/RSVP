import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { listSessionsHandler } from "./handler";
import { buildFindSessions, type PrismaSessionFinder } from "./query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Thin wrapper around the pure `listSessionsHandler`. All decision
// logic (auth, limit parse/clamp, preview derivation) lives in
// handler.ts where it's covered by unit tests without an RSC runtime
// or real Prisma. The Prisma query SHAPE — including the load-
// bearing `_count` role filter that keeps tool fan-out out of the
// picker badge — lives in query.ts and is unit-tested separately.
//
// This file's only job:
//   1. Inject the real deps: getCurrentUser + buildFindSessions(prisma).
//   2. Translate the returned `ListSessionsResult` into NextResponse.
//
// `as never` on the prisma cast is the same typed-pass-through the
// chat route uses for the workspace emitter: Prisma's generated
// FindManyArgs carry many optional fields our narrow
// `FindSessionsArgs` deliberately omits (select: {other fields},
// include, distinct, etc.), and structural-compat would otherwise
// complain. The REAL type compatibility is verified at runtime by
// the integration between buildFindSessions and prisma.chatSession.

export async function GET(req: Request) {
  const result = await listSessionsHandler(req, {
    getCurrentUser,
    findSessions: buildFindSessions(prisma as unknown as PrismaSessionFinder),
  });

  if (result.kind === "error") {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.json(result.body, { status: 200 });
}
