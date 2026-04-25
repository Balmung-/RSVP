import { NextResponse } from "next/server";
import { clearFlash } from "@/lib/flash";

export async function POST() {
  clearFlash();
  return new NextResponse(null, { status: 204 });
}
