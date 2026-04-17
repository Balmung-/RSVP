import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Nafath OIDC callback. Real flow: verify state, exchange `code` for tokens
// via the token endpoint, validate ID token signature against JWKS, look up
// or provision a User row, then `startSession`. Kept as a stub so the URL
// shape is stable for the Nafath IdP configuration.

export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      error: "nafath_not_implemented",
      hint: "Exchange code for tokens, validate ID token, upsert User, then call startSession.",
    },
    { status: 501 },
  );
}
