import Link from "next/link";
import { Badge } from "@/components/Badge";
import type { ChannelReadiness } from "@/lib/channel-readiness";

export function CampaignMessageSetup({
  campaignId,
  channels,
  canWrite,
}: {
  campaignId: string;
  channels: ChannelReadiness[];
  canWrite: boolean;
}) {
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sub text-ink-900">Message setup</h2>
          <p className="mt-1 max-w-2xl text-body text-ink-500">
            Email and SMS use the campaign's own copy. WhatsApp uses an approved provider template plus
            any required PDF header. This is the source of truth before send.
          </p>
          <p className="mt-1 max-w-2xl text-mini text-ink-500">
            The Templates page is only for reusable email and SMS copy. WhatsApp is chosen inside
            campaign edit under <span className="font-medium text-ink-700">WhatsApp message setup</span>.
          </p>
        </div>
        {canWrite ? (
          <Link href={`/campaigns/${campaignId}/edit`} className="btn-ghost text-xs shrink-0">
            Edit message setup
          </Link>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {channels.map((channel) => (
          <div key={channel.channel} className="panel-quiet p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-body font-medium text-ink-900">{channel.label}</div>
              <Badge tone={channel.ready ? "live" : "hold"}>
                {channel.ready ? "ready" : "setup needed"}
              </Badge>
            </div>
            <div className="mt-3 text-body text-ink-700">{channel.reason}</div>
            {channel.detail ? (
              <div className="mt-1 text-mini text-ink-500">{channel.detail}</div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
