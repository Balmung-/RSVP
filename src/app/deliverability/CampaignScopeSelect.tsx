"use client";

import { useRouter } from "next/navigation";

type SearchParams = {
  campaign?: string;
  channel?: string;
  status?: string;
};

export function buildDeliverabilityHref(
  searchParams: SearchParams,
  patch: Partial<SearchParams>,
) {
  const next = { ...searchParams, ...patch };
  const entries = Object.entries(next).filter(([, value]) => value && value !== "all");
  return entries.length
    ? `/deliverability?${new URLSearchParams(entries as [string, string][]).toString()}`
    : "/deliverability";
}

export function CampaignScopeSelect({
  campaigns,
  selected,
  searchParams,
}: {
  campaigns: Array<{ id: string; name: string }>;
  selected: string;
  searchParams: SearchParams;
}) {
  const router = useRouter();
  return (
    <select
      value={selected}
      onChange={(e) =>
        router.push(
          buildDeliverabilityHref(searchParams, {
            campaign: e.target.value === "all" ? undefined : e.target.value,
          }),
        )
      }
      className="min-w-[9rem] rounded-md border-0 bg-ink-100 px-2 py-1 text-mini text-ink-700 transition-colors hover:bg-ink-200 hover:text-ink-900 focus:outline-none focus:ring-1 focus:ring-ink-900"
    >
      <option value="all">All</option>
      {campaigns.map((campaign) => (
        <option key={campaign.id} value={campaign.id}>
          {campaign.name}
        </option>
      ))}
    </select>
  );
}
