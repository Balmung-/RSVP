import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Nafath SSO seam — entry point. Real integration: redirect to Nafath's OIDC
// authorize URL with client_id, redirect_uri, state (CSRF), and scope. Keep
// the surface small here so swapping in the production flow is isolated.

export async function GET() {
  if (process.env.NAFATH_CLIENT_ID && process.env.NAFATH_AUTH_URL) {
    // Real flow goes here. For now we emit a 501 with a machine-readable tag
    // so ops can see the integration is wired but not implemented.
    return NextResponse.json(
      {
        ok: false,
        error: "nafath_not_implemented",
        hint: "Wire the OIDC authorize redirect + PKCE state cookie here.",
      },
      { status: 501 },
    );
  }
  return NextResponse.json(
    {
      ok: false,
      error: "nafath_not_configured",
      hint: "Set NAFATH_CLIENT_ID, NAFATH_CLIENT_SECRET, NAFATH_AUTH_URL, NAFATH_TOKEN_URL, NAFATH_JWKS_URL.",
    },
    { status: 503 },
  );
}
