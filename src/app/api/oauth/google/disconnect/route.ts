import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { revokeGoogleToken } from "@/lib/oauth/google";
import { decryptSecret } from "@/lib/secrets";
import { logAction } from "@/lib/audit";
import { disconnectHandler } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Thin wrapper around the pure `disconnectHandler`. All decision
// logic — admin gate, decrypt, remote revoke, local delete, audit
// emission, redirect resolution — lives in handler.ts where it's
// covered by unit tests without an RSC runtime or real Prisma /
// Google. This file's only job:
//   1. Inject the real deps (getCurrentUser, prisma.oAuthAccount
//      queries, logAction, revokeGoogleToken, decryptSecret,
//      process.env).
//   2. Translate the returned `DisconnectResult` into NextResponse
//      shapes.
//
// Keep this wrapper trivial. Any new "why" comment belongs in
// handler.ts so tests and production code share the same narrative.

export async function POST(req: Request) {
  const result = await disconnectHandler(req, {
    getCurrentUser,
    hasRole,
    logAction,
    // orderBy: freshest-first, so NULL-race duplicates resolve to
    // the same row the send path picks. See gmail.ts for the full
    // reasoning behind this tuple.
    findAccount: (teamId) =>
      prisma.oAuthAccount.findFirst({
        where: { provider: "google", teamId },
        orderBy: [
          { updatedAt: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        select: {
          id: true,
          teamId: true,
          googleEmail: true,
          refreshTokenEnc: true,
        },
      }),
    deleteAccounts: (teamId) =>
      prisma.oAuthAccount.deleteMany({
        where: { provider: "google", teamId },
      }),
    revokeGoogleToken,
    decryptSecret,
    // Pick only the fields disconnectHandler consults. Passing raw
    // `process.env` fails the TS structural check because
    // NodeJS.ProcessEnv declares no properties that overlap with
    // the narrowed DisconnectEnv interface.
    env: {
      APP_BASE_URL: process.env.APP_BASE_URL,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    },
  });

  if (result.kind === "json") {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.redirect(result.location, result.status);
}
