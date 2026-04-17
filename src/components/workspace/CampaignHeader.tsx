import Link from "next/link";
import type { Campaign } from "@prisma/client";
import { Menu, MenuItem, MenuSeparator } from "@/components/Menu";

// Workspace header: one dominant title, quiet metadata row, one primary
// action and one kebab for everything else. Eleven header buttons became two.

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const dateFmt = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TZ,
});

const statusColor: Record<string, string> = {
  draft: "bg-ink-300",
  active: "bg-signal-live",
  sending: "bg-signal-hold animate-pulse",
  closed: "bg-ink-400",
  archived: "bg-ink-300",
};

export function CampaignHeader({
  campaign,
  sendAction,
  canWrite,
  canDelete,
  headcount,
  invited,
  responded,
}: {
  campaign: Campaign;
  sendAction: (fd: FormData) => Promise<void> | void;
  canWrite: boolean;
  canDelete: boolean;
  headcount: number;
  invited: number;
  responded: number;
}) {
  const bits = [
    campaign.venue,
    campaign.eventAt ? dateFmt.format(campaign.eventAt) : null,
  ].filter(Boolean);

  return (
    <div className="-mt-2 pb-6">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${statusColor[campaign.status] ?? "bg-ink-300"}`}
              aria-hidden
            />
            <span className="text-[11px] uppercase tracking-wider text-ink-400">
              {campaign.status}
            </span>
          </div>
          <h1 className="text-2xl font-medium tracking-tightest text-ink-900 truncate">
            {campaign.name}
          </h1>
          {bits.length > 0 ? (
            <p className="text-sm text-ink-500 mt-1 tabular-nums">{bits.join(" · ")}</p>
          ) : null}
          <p className="text-xs text-ink-400 mt-3 tabular-nums">
            {invited} invited
            <span className="mx-1.5 text-ink-300">·</span>
            {responded} responded
            <span className="mx-1.5 text-ink-300">·</span>
            {headcount} expected headcount
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {canWrite ? (
            <form action={sendAction} className="inline-flex items-center gap-2">
              <input type="hidden" name="id" value={campaign.id} />
              <label className="sr-only" htmlFor="send-channel">Channel</label>
              <select
                id="send-channel"
                name="channel"
                className="field !py-1.5 !px-3 !text-sm !w-auto"
                defaultValue="both"
                aria-label="Channels"
              >
                <option value="both">Email & SMS</option>
                <option value="email">Email only</option>
                <option value="sms">SMS only</option>
              </select>
              <button className="btn-primary" disabled={campaign.status === "sending"}>
                {campaign.status === "sending" ? "Sending…" : "Send invitations"}
              </button>
            </form>
          ) : null}

          <Menu label="More actions" trigger={<span className="text-lg leading-none">⋯</span>}>
            <MenuItem as="link" href={`/campaigns/${campaign.id}/edit`}>Edit settings</MenuItem>
            {canWrite ? (
              <>
                <MenuItem as="link" href={`/campaigns/${campaign.id}/test`}>Send test message</MenuItem>
                <MenuItem as="link" href={`/campaigns/${campaign.id}/import`}>Import CSV</MenuItem>
              </>
            ) : null}
            <MenuSeparator />
            <MenuItem as="link" href={`/api/campaigns/${campaign.id}/export`}>Export responses (CSV)</MenuItem>
            <MenuItem as="link" href={`/campaigns/${campaign.id}/roster`} target="_blank">Open print roster</MenuItem>
            {canDelete ? (
              <>
                <MenuSeparator />
                <MenuItem as="link" href={`/campaigns/${campaign.id}/edit`} danger>
                  Delete campaign…
                </MenuItem>
              </>
            ) : null}
          </Menu>
        </div>
      </div>
    </div>
  );
}

// Wrapper that positions the header as a link when Shell title is already
// being used for the breadcrumb.
export function CampaignHeaderCrumb({ campaign }: { campaign: Campaign }) {
  return (
    <span>
      <Link href="/" className="hover:underline">Campaigns</Link>
      <span className="mx-1.5 text-ink-300">/</span>
      <span>{campaign.name}</span>
    </span>
  );
}
