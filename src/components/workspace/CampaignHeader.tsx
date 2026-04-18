import Link from "next/link";
import type { Campaign } from "@prisma/client";
import { Menu, MenuItem, MenuSeparator } from "@/components/Menu";
import { SendDialog } from "@/components/SendDialog";
import { Icon, type IconName } from "@/components/Icon";
import { readAdminLocale, readAdminCalendar, adminDict, formatAdminDate } from "@/lib/adminLocale";

// Workspace header: one dominant title, quiet metadata, one primary action
// (Send invitations → opens the SendDialog) and one kebab for everything else.

const statusColor: Record<string, string> = {
  draft: "bg-ink-300",
  active: "bg-signal-live",
  sending: "bg-signal-hold",
  closed: "bg-ink-400",
  archived: "bg-ink-300",
};

export async function CampaignHeader({
  campaign,
  sendAction,
  sendSummary,
  duplicateAction,
  canWrite,
  canDelete,
  headcount,
  invited,
  responded,
}: {
  campaign: Campaign;
  sendAction: (fd: FormData) => Promise<void>;
  sendSummary: {
    invited: number;
    withEmail: number;
    withPhone: number;
    alreadyEmailSent: number;
    alreadySmsSent: number;
  };
  duplicateAction: () => Promise<void>;
  canWrite: boolean;
  canDelete: boolean;
  headcount: number;
  invited: number;
  responded: number;
}) {
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();
  const T = adminDict(locale);
  const bits = [
    campaign.venue,
    campaign.eventAt
      ? formatAdminDate(campaign.eventAt, locale, calendar, { dateStyle: "medium", timeStyle: "short" })
      : null,
  ].filter(Boolean);

  return (
    <div className="pb-8">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-3">
            <span
              className={`h-1.5 w-1.5 rounded-full ${statusColor[campaign.status] ?? "bg-ink-300"} ${campaign.status === "sending" ? "animate-pulse" : ""}`}
              aria-hidden
            />
            <span className="text-micro text-ink-500">
              {(T[campaign.status as keyof typeof T] as string | undefined) ?? campaign.status.toUpperCase()}
            </span>
          </div>
          <h1
            className="text-ink-900 truncate"
            style={{ fontSize: "30px", lineHeight: "36px", letterSpacing: "-0.02em", fontWeight: 500 }}
          >
            {campaign.name}
          </h1>
          {bits.length > 0 ? (
            <p className="text-body text-ink-500 mt-1.5 tabular-nums">{bits.join(" · ")}</p>
          ) : null}
          <div className="flex items-center gap-5 mt-4 text-body text-ink-600 tabular-nums">
            <InlineStat label={T.invited} value={invited} />
            <Divider />
            <InlineStat label={T.responded} value={responded} />
            <Divider />
            <InlineStat label={T.headcount} value={headcount} emphasize />
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <SendDialog
            campaignId={campaign.id}
            summary={sendSummary}
            status={campaign.status}
            action={sendAction}
            canWrite={canWrite}
          />

          <Menu
            label="More actions"
            trigger={<Icon name="more" size={16} className="text-ink-700" />}
          >
            <MenuItem as="link" href={`/campaigns/${campaign.id}/edit`}>
              <MenuRow icon="pencil" label="Edit settings" />
            </MenuItem>
            {canWrite ? (
              <>
                <MenuItem as="link" href={`/campaigns/${campaign.id}/test`}>
                  <MenuRow icon="send" label="Send test message" />
                </MenuItem>
                <MenuItem as="link" href={`/campaigns/${campaign.id}/import`}>
                  <MenuRow icon="upload" label="Import CSV" />
                </MenuItem>
                <form action={duplicateAction}>
                  <MenuItem as="button">
                    <MenuRow icon="copy" label="Duplicate campaign" />
                  </MenuItem>
                </form>
              </>
            ) : null}
            <MenuSeparator />
            <MenuItem as="link" href={`/api/campaigns/${campaign.id}/export`}>
              <MenuRow icon="download" label="Export responses (CSV)" />
            </MenuItem>
            <MenuItem as="link" href={`/campaigns/${campaign.id}/roster`} target="_blank">
              <MenuRow icon="printer" label="Open print roster" />
            </MenuItem>
            <MenuItem as="link" href={`/kiosk/${campaign.id}`} target="_blank">
              <MenuRow icon="qr" label="Open door kiosk" />
            </MenuItem>
            <MenuItem as="link" href={`/campaigns/${campaign.id}/catering`}>
              <MenuRow icon="list" label="Catering summary" />
            </MenuItem>
            {canDelete ? (
              <>
                <MenuSeparator />
                <MenuItem as="link" href={`/campaigns/${campaign.id}/edit`} danger>
                  <MenuRow icon="trash" label="Delete campaign…" />
                </MenuItem>
              </>
            ) : null}
          </Menu>
        </div>
      </div>
    </div>
  );
}

export function CampaignHeaderCrumb({ campaign }: { campaign: Campaign }) {
  return (
    <span>
      <Link href="/campaigns" className="hover:text-ink-900 transition-colors">Campaigns</Link>
      <span className="mx-1.5 text-ink-300">/</span>
      <span className="truncate">{campaign.name}</span>
    </span>
  );
}

function InlineStat({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-micro uppercase text-ink-400">{label}</span>
      <span className={emphasize ? "text-ink-900 font-medium" : ""}>{value.toLocaleString()}</span>
    </span>
  );
}

function Divider() {
  return <span className="h-3 w-px bg-ink-200" aria-hidden />;
}

function MenuRow({ icon, label }: { icon: IconName; label: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <Icon name={icon} size={14} className="text-ink-500" />
      <span>{label}</span>
    </span>
  );
}
