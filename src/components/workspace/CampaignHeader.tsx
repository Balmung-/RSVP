import Link from "next/link";
import type { Campaign } from "@prisma/client";
import { Menu, MenuItem, MenuSeparator } from "@/components/Menu";
import { SendDialog } from "@/components/SendDialog";
import { Icon, type IconName } from "@/components/Icon";
import { readAdminLocale, readAdminCalendar, adminDict, formatAdminDate } from "@/lib/adminLocale";
import type { ChannelReadiness } from "@/lib/channel-readiness";

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
  messageSetup,
}: {
  campaign: Campaign;
  sendAction: (fd: FormData) => Promise<void>;
  sendSummary: {
    invited: number;
    withEmail: number;
    withSms: number;
    withWhatsApp: number;
    alreadyEmailSent: number;
    alreadySmsSent: number;
    alreadyWhatsAppSent: number;
  };
  duplicateAction: () => Promise<void>;
  canWrite: boolean;
  canDelete: boolean;
  headcount: number;
  invited: number;
  responded: number;
  messageSetup: ChannelReadiness[];
}) {
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();
  const T = adminDict(locale);
  const statusLabel =
    (T[campaign.status as keyof typeof T] as string | undefined) ??
    campaign.status.toUpperCase();
  const metaBits = [
    campaign.venue,
    campaign.eventAt
      ? formatAdminDate(campaign.eventAt, locale, calendar, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : null,
  ].filter(Boolean) as string[];

  return (
    <div className="flex min-w-0 items-center gap-6 pb-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${statusColor[campaign.status] ?? "bg-ink-300"} ${campaign.status === "sending" ? "animate-pulse" : ""}`}
          aria-hidden
          title={statusLabel}
        />
        <h1
          className="min-w-0 truncate text-ink-900"
          style={{ fontSize: "24px", lineHeight: "30px", letterSpacing: "-0.015em", fontWeight: 500 }}
        >
          {campaign.name}
        </h1>
        {metaBits.length > 0 ? (
          <span className="hidden truncate text-mini tabular-nums text-ink-500 md:inline">
            {metaBits.join(" - ")}
          </span>
        ) : null}
      </div>

      <div className="hidden shrink-0 items-center gap-5 text-body tabular-nums text-ink-600 lg:flex">
        <InlineStat label={T.invited} value={invited} />
        <Divider />
        <InlineStat label={T.responded} value={responded} />
        <Divider />
        <InlineStat label={T.headcount} value={headcount} emphasize />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <SendDialog
          campaignId={campaign.id}
          summary={sendSummary}
          status={campaign.status}
          action={sendAction}
          canWrite={canWrite}
          setup={messageSetup}
          editHref={`/campaigns/${campaign.id}/edit`}
        />
        <Link href={`/campaigns/${campaign.id}/activity`} className="btn btn-ghost text-xs">
          Activity log
        </Link>
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
                <MenuRow icon="upload" label="Import file" />
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
          <MenuItem as="link" href={`/campaigns/${campaign.id}/activity`}>
            <MenuRow icon="list" label="Activity log" />
          </MenuItem>
          {canDelete ? (
            <>
              <MenuSeparator />
              <MenuItem as="link" href={`/campaigns/${campaign.id}/edit`} danger>
                <MenuRow icon="trash" label="Delete campaign..." />
              </MenuItem>
            </>
          ) : null}
        </Menu>
      </div>
    </div>
  );
}

export function CampaignHeaderCrumb({ campaign }: { campaign: Campaign }) {
  return (
    <span>
      <Link href="/campaigns" className="transition-colors hover:text-ink-900">Campaigns</Link>
      <span className="mx-1.5 text-ink-300">/</span>
      <span className="truncate">{campaign.name}</span>
    </span>
  );
}

function InlineStat({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-micro uppercase text-ink-400">{label}</span>
      <span className={emphasize ? "font-medium text-ink-900" : ""}>{value.toLocaleString()}</span>
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
