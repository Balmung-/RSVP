import Link from "next/link";
import type { Campaign, Invitation, Invitee, Response as RsvpResponse } from "@prisma/client";
import { Drawer } from "./Drawer";
import { Badge } from "./Badge";
import { ConfirmButton } from "./ConfirmButton";

// Right drawer for a single invitee. Read-only summary up top; write actions
// are stacked in the footer. Opens whenever `?invitee=<id>` is in the URL.

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

const statusTone = { queued: "wait", sent: "live", delivered: "live", failed: "fail", bounced: "fail" } as const;

export function InviteePanel({
  campaign,
  invitee,
  response,
  invitations,
  closeHref,
  appUrl,
  resendAction,
  deleteAction,
}: {
  campaign: Campaign;
  invitee: Invitee;
  response: RsvpResponse | null;
  invitations: Invitation[];
  closeHref: string;
  appUrl: string;
  resendAction: (fd: FormData) => Promise<void> | void;
  deleteAction: (fd: FormData) => Promise<void> | void;
}) {
  const rsvpUrl = `${appUrl.replace(/\/$/, "")}/rsvp/${invitee.rsvpToken}`;
  const emailInv = invitations.filter((i) => i.channel === "email").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const smsInv = invitations.filter((i) => i.channel === "sms").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const respTone = response ? (response.attending ? "live" : "fail") : "wait";
  const respLabel = response ? (response.attending ? "attending" : "declined") : "pending";

  return (
    <Drawer
      title={invitee.fullName}
      crumb={[invitee.title, invitee.organization].filter(Boolean).join(" · ") || undefined}
      closeHref={closeHref}
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3 flex-wrap gap-y-2">
          <form action={deleteAction}>
            <input type="hidden" name="inviteeId" value={invitee.id} />
            <ConfirmButton
              prompt={`Remove ${invitee.fullName} from ${campaign.name}? Their response (if any) is deleted too.`}
            >
              Delete invitee
            </ConfirmButton>
          </form>
          <div className="flex gap-2 flex-wrap">
            <Link
              href={`/campaigns/${campaign.id}/invitees/${invitee.id}/preview/email`}
              target="_blank"
              className="btn-ghost text-xs"
            >
              Preview email
            </Link>
            <Link
              href={`/campaigns/${campaign.id}/invitees/${invitee.id}/preview/sms`}
              target="_blank"
              className="btn-ghost text-xs"
            >
              Preview SMS
            </Link>
            <Link
              href={`/campaigns/${campaign.id}/invitees/${invitee.id}/edit`}
              className="btn-ghost text-xs"
            >
              Edit
            </Link>
            <form action={resendAction} className="inline-flex gap-2">
              <input type="hidden" name="inviteeId" value={invitee.id} />
              <button name="channel" value="email" disabled={!invitee.email} className="btn-primary text-xs">
                Resend email
              </button>
              <button name="channel" value="sms" disabled={!invitee.phoneE164} className="btn-primary text-xs">
                Resend SMS
              </button>
            </form>
          </div>
        </div>
      }
    >
      <section className="grid grid-cols-2 gap-6">
        <Kv label="Email" value={invitee.email ?? "—"} mono />
        <Kv label="Phone" value={invitee.phoneE164 ?? "—"} mono />
        <Kv label="Locale" value={invitee.locale ?? `${campaign.locale} (campaign)`} />
        <Kv label="Guests allowed" value={String(invitee.guestsAllowed)} />
        <Kv label="Tags" value={invitee.tags || "—"} />
        <Kv label="Added" value={fmt.format(invitee.createdAt)} />
      </section>

      {invitee.notes ? (
        <section className="mt-6">
          <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-1">Notes</div>
          <p className="text-sm text-ink-700 whitespace-pre-wrap">{invitee.notes}</p>
        </section>
      ) : null}

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider text-ink-400">Response</div>
          <Badge tone={respTone}>{respLabel}</Badge>
        </div>
        {response ? (
          <div className="mt-2 text-sm text-ink-700">
            <div>
              {response.attending ? "Attending" : "Not attending"}
              {response.attending && response.guestsCount > 0 ? ` · ${response.guestsCount} guest${response.guestsCount === 1 ? "" : "s"}` : ""}
            </div>
            <div className="text-xs text-ink-400 mt-0.5">{fmt.format(response.respondedAt)}</div>
            {response.message ? (
              <p className="mt-2 text-sm text-ink-600 whitespace-pre-wrap border-l-2 border-ink-200 pl-3">
                {response.message}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="mt-8">
        <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-2">RSVP link</div>
        <input
          readOnly
          value={rsvpUrl}
          className="field font-mono text-xs select-all"
        />
      </section>

      <section className="mt-8 grid grid-cols-2 gap-6">
        <ChannelHistory label="Email" items={emailInv} />
        <ChannelHistory label="SMS" items={smsInv} />
      </section>
    </Drawer>
  );
}

function Kv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className={`text-sm text-ink-900 mt-0.5 ${mono ? "font-mono tabular-nums" : ""}`}>{value}</div>
    </div>
  );
}

function ChannelHistory({ label, items }: { label: string; items: Invitation[] }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-2">{label}</div>
      {items.length === 0 ? (
        <div className="text-xs text-ink-400">No attempts.</div>
      ) : (
        <ul className="space-y-2">
          {items.slice(0, 5).map((inv) => {
            const tone = statusTone[inv.status as keyof typeof statusTone] ?? "muted";
            return (
              <li key={inv.id} className="flex items-start justify-between text-xs">
                <div>
                  <Badge tone={tone}>{inv.status}</Badge>
                  {inv.error ? <div className="text-ink-400 mt-1 max-w-[14rem] truncate">{inv.error}</div> : null}
                </div>
                <div className="text-ink-400 tabular-nums">{fmt.format(inv.createdAt)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
