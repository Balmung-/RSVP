"use client";

import Link from "next/link";
import clsx from "clsx";

// Renders the `contact_table` directive emitted by `search_contacts`.
// Each row is a link to `/contacts/<id>` so the operator can open
// for edit/invite in a single click. Tier chips follow the
// `VIP_LABEL` convention — royal/minister/vip get distinct muted
// tones; standard gets no chip to keep the table quiet.

export type ContactTableProps = {
  items: Array<{
    id: string;
    full_name: string;
    title: string | null;
    organization: string | null;
    email: string | null;
    phone_e164: string | null;
    vip_tier: "royal" | "minister" | "vip" | "standard";
    vip_label: string;
    tags: string | null;
    archived_at: string | null;
    invitee_count: number;
  }>;
  total: number;
  filters?: {
    query: string | null;
    tier: string;
    include_archived: boolean;
    limit: number;
  };
};

const TIER_CLASS: Record<string, string> = {
  royal: "bg-purple-100 text-purple-800",
  minister: "bg-indigo-100 text-indigo-800",
  vip: "bg-amber-100 text-amber-800",
  standard: "",
};

export function ContactTable({ props }: { props: ContactTableProps }) {
  const items = props.items ?? [];

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        No contacts matched.
      </div>
    );
  }

  const remaining = props.total - items.length;

  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <ul className="divide-y divide-slate-100">
        {items.map((c) => (
          <li key={c.id} className="px-3 py-2">
            <Link
              href={`/contacts/${c.id}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm hover:bg-slate-50 -mx-3 px-3 py-1 rounded"
            >
              <span className="font-medium text-slate-900">{c.full_name}</span>
              {c.vip_tier !== "standard" && (
                <span
                  className={clsx(
                    "rounded px-1.5 py-0.5 text-[11px] font-medium",
                    TIER_CLASS[c.vip_tier] ?? "",
                  )}
                >
                  {c.vip_label}
                </span>
              )}
              {c.organization && (
                <span className="text-slate-500">{c.organization}</span>
              )}
              {(c.email || c.phone_e164) && (
                <span className="text-slate-500 tabular-nums">
                  {c.email ?? c.phone_e164}
                </span>
              )}
              {c.archived_at && (
                <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-500">
                  archived
                </span>
              )}
              {c.invitee_count > 0 && (
                <span className="ms-auto text-slate-500 tabular-nums text-xs">
                  {c.invitee_count} invite{c.invitee_count === 1 ? "" : "s"}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <div className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100">
          + {remaining} more matching the current filter.
        </div>
      )}
    </div>
  );
}
