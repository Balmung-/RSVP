"use client";

import { useRouter } from "next/navigation";

// Inline select matched to the filter-pill voice. Navigates on change
// — no submit button, no nested form — so it sits alongside the
// pills as a third calm control rather than a separate panel.

type SearchParams = {
  campaign?: string;
  channel?: string;
  status?: string;
};

export function CampaignScopeSelect({
  campaigns,
  selected,
  qs,
}: {
  campaigns: Array<{ id: string; name: string }>;
  selected: string;
  qs: (patch: Partial<SearchParams>) => string;
}) {
  const router = useRouter();
  return (
    <select
      value={selected}
      onChange={(e) =>
        router.push(qs({ campaign: e.target.value === "all" ? undefined : e.target.value }))
      }
      className="bg-ink-100 text-ink-700 hover:bg-ink-200 hover:text-ink-900 transition-colors text-mini rounded-md px-2 py-1 border-0 focus:outline-none focus:ring-1 focus:ring-ink-900 min-w-[9rem]"
    >
      <option value="all">All</option>
      {campaigns.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
