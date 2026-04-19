import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { buildAuthUrl } from "@/lib/oauth/google";
import { signState } from "@/lib/oauth/state";
import { logAction } from "@/lib/audit";
import { startHandler } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Thin wrapper around the pure `startHandler`. All of the logic —
// admin gate, env check, teamId validation, state-signing, nonce
// cookie — lives in handler.ts where it's covered by unit tests
// without an RSC runtime or a real Prisma. This file's only job:
//   1. Inject the real deps (getCurrentUser, prisma.team, logAction,
//      signState, buildAuthUrl, process.env).
//   2. Translate the returned `StartResult` back into NextResponse
//      shapes (NextResponse.json for the error branches,
//      NextResponse.redirect + cookies() for the happy path and the
//      /settings failure redirect).
//
// Keep this wrapper trivial. Any new "why" comment belongs in
// handler.ts so tests and production code share the same narrative.

export async function GET(req: Request) {
  const result = await startHandler(req, {
    getCurrentUser,
    hasRole,
    logAction,
    findTeamById: (id) =>
      prisma.team.findUnique({ where: { id }, select: { id: true } }),
    signState,
    buildAuthUrl,
    // Pick only the fields startHandler consults. Passing the raw
    // `process.env` here fails the TS structural check because
    // NodeJS.ProcessEnv has no explicit property overlap with the
    // narrowed StartEnv interface.
    env: {
      GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
      OAUTH_ENCRYPTION_KEY: process.env.OAUTH_ENCRYPTION_KEY,
      APP_BASE_URL: process.env.APP_BASE_URL,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NODE_ENV: process.env.NODE_ENV,
    },
  });

  if (result.kind === "json") {
    return NextResponse.json(result.body, { status: result.status });
  }

  // Apply cookies FIRST, then redirect. Next.js `cookies()` is a
  // mutable store for the current response — the cookie sticks to
  // whatever response object this route returns. Order doesn't
  // matter for correctness (the redirect is a plain location
  // header), but applying cookies before constructing the response
  // mirrors the original hand-written route and keeps diffs small.
  if (result.cookies) {
    const jar = cookies();
    for (const c of result.cookies) {
      jar.set(c.name, c.value, c.options);
    }
  }
  return NextResponse.redirect(result.location, result.status);
}
