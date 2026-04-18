import { cache } from "react";
import type { User } from "@prisma/client";
import { hasRole } from "@/lib/auth";
import { scopedCampaignWhere } from "@/lib/teams";
import { readAdminLocale } from "@/lib/adminLocale";
import type { ToolCtx } from "./tools/types";

// One place to assemble the request-scoped context every tool
// handler needs: resolved user, isAdmin flag, current admin locale,
// and the team-scoped campaign WHERE fragment. Wrapped in React's
// `cache()` so a single chat turn that dispatches multiple tools
// doesn't re-query team membership per call.
//
// This function does NOT authenticate — the caller must have already
// resolved the user via getCurrentUser() (or an equivalent gate) and
// hand it in. That keeps route-level concerns (401s, rate limiting)
// separate from the tool layer.

export const buildToolCtx = cache(async function buildToolCtx(
  user: User,
): Promise<ToolCtx> {
  const isAdmin = hasRole(user, "admin");
  const locale = readAdminLocale();
  const campaignScope = await scopedCampaignWhere(user.id, isAdmin);
  return { user, isAdmin, locale, campaignScope };
});
