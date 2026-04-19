import { searchContacts, VIP_LABEL, type VipTier } from "@/lib/contacts";
import type { ToolDef, ToolResult } from "./types";

// Text search across the contact book, optionally narrowed by VIP
// tier. Matches the `searchContacts` helper used by
// `/api/contacts/search` and the campaign audience picker, so the
// model sees the same semantics the rest of the app does.
//
// NO team scope: contacts are global across the tenant in this
// codebase (there is no `Contact.teamId`). Campaigns are the
// team-scoped surface; contacts are an address-book. If that
// changes in the future we extend this tool, not the other way
// round.
//
// The row cap is low by design — the model only needs enough
// context to phrase a reply, and the `contact_table` workspace
// widget renders the same data back to the operator with a "show
// more" affordance (via the `total` count). Defaults to 20; max 50
// to keep the model-facing payload terse.
//
// WidgetKey `contacts.table` is stable — re-searching replaces the
// previous results rather than stacking multiple tables in
// `primary`. Refining the filters is the common case and the
// operator expects the table to update in place.

type Input = {
  query?: string;
  tier?: VipTier | "all";
  include_archived?: boolean;
  limit?: number;
};

const TIERS: readonly (VipTier | "all")[] = [
  "all",
  "royal",
  "minister",
  "vip",
  "standard",
];
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export const searchContactsTool: ToolDef<Input> = {
  name: "search_contacts",
  description:
    "Search the contact book by name / email / phone / organization / tags. Optionally filter by VIP tier. Returns each contact's headline fields (name, tier, organization, email, phone, invitee count) plus a total-matching count. Archived contacts are excluded by default.",
  scope: "read",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description:
          "Free-text search across name, email, phone, organization, and tags. Case-insensitive.",
      },
      tier: {
        type: "string",
        enum: ["all", "royal", "minister", "vip", "standard"],
        description: "Filter to a single VIP tier, or 'all' for no filter.",
      },
      include_archived: {
        type: "boolean",
        description:
          "Include archived contacts in results. Defaults to false.",
      },
      limit: {
        type: "number",
        description: `Max rows to return (1–${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
  },
  validate(raw): Input {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("expected_object");
    }
    const r = raw as Record<string, unknown>;
    const out: Input = {};
    if (typeof r.query === "string" && r.query.trim().length > 0) {
      out.query = r.query.trim().slice(0, 200);
    }
    if (
      typeof r.tier === "string" &&
      (TIERS as readonly string[]).includes(r.tier)
    ) {
      out.tier = r.tier as VipTier | "all";
    }
    if (typeof r.include_archived === "boolean") {
      out.include_archived = r.include_archived;
    }
    if (typeof r.limit === "number" && Number.isFinite(r.limit)) {
      out.limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(r.limit)));
    }
    return out;
  },
  async handler(input): Promise<ToolResult> {
    const tier = input.tier ?? "all";
    const limit = input.limit ?? DEFAULT_LIMIT;
    const { total, rows } = await searchContacts({
      q: input.query,
      tier,
      includeArchived: input.include_archived ?? false,
      take: limit,
    });

    const items = rows.map((c) => {
      const t = (c.vipTier as VipTier) ?? "standard";
      return {
        id: c.id,
        full_name: c.fullName,
        title: c.title ?? null,
        organization: c.organization ?? null,
        email: c.email ?? null,
        phone_e164: c.phoneE164 ?? null,
        vip_tier: t,
        vip_label: VIP_LABEL[t] ?? t,
        tags: c.tags ?? null,
        archived_at: c.archivedAt ? c.archivedAt.toISOString() : null,
        invitee_count: c._count?.invitees ?? 0,
      };
    });

    // Compact text summary for the model.
    const lines: string[] = [];
    if (items.length === 0) {
      lines.push(
        input.query
          ? `No contacts match "${input.query}"${tier !== "all" ? ` in tier ${tier}` : ""}.`
          : "No contacts match the current filters.",
      );
    } else {
      const head =
        total > items.length
          ? `${items.length} of ${total} contacts:`
          : `${items.length} contact${items.length === 1 ? "" : "s"}:`;
      lines.push(head);
      for (const it of items) {
        const org = it.organization ? ` — ${it.organization}` : "";
        const contact =
          it.email ?? it.phone_e164 ?? "(no email or phone)";
        lines.push(
          `- ${it.full_name} (${it.vip_label})${org} — ${contact}`,
        );
      }
    }

    const props = {
      items,
      total,
      filters: {
        query: input.query ?? null,
        tier,
        include_archived: Boolean(input.include_archived),
        limit,
      },
    };

    return {
      output: { summary: lines.join("\n"), count: items.length, total },
      widget: {
        widgetKey: "contacts.table",
        kind: "contact_table",
        slot: "primary",
        props,
      },
    };
  },
};
