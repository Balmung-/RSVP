import Link from "next/link";
import type {
  Answer,
  Campaign,
  CampaignQuestion,
  EventOption,
  Invitation,
  Invitee,
  Response as RsvpResponse,
} from "@prisma/client";
import { Drawer } from "./Drawer";
import { Badge } from "./Badge";
import { ConfirmButton } from "./ConfirmButton";
import { hasWhatsAppTemplate, isChannelProviderEnabled } from "@/lib/channel-availability";
import { buildInviteeChannelReadiness } from "@/lib/channel-readiness";

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
  questions,
  answers,
  eventOptions,
  closeHref,
  appUrl,
  resendAction,
  deleteAction,
}: {
  campaign: Campaign;
  invitee: Invitee;
  response: RsvpResponse | null;
  invitations: Invitation[];
  questions: CampaignQuestion[];
  answers: Answer[];
  eventOptions: EventOption[];
  closeHref: string;
  appUrl: string;
  resendAction: (fd: FormData) => Promise<void> | void;
  deleteAction: (fd: FormData) => Promise<void> | void;
}) {
  const answerByQuestion = new Map(answers.map((answer) => [answer.questionId, answer.value]));
  const chosenDate = response?.eventOptionId
    ? eventOptions.find((option) => option.id === response.eventOptionId)
    : null;
  const rsvpUrl = `${appUrl.replace(/\/$/, "")}/rsvp/${invitee.rsvpToken}`;

  const emailAvailable = isChannelProviderEnabled("email") && !!invitee.email;
  const smsAvailable = isChannelProviderEnabled("sms") && !!invitee.phoneE164;
  const whatsappAvailable =
    isChannelProviderEnabled("whatsapp") &&
    !!invitee.phoneE164 &&
    hasWhatsAppTemplate({
      templateWhatsAppName: campaign.templateWhatsAppName,
      templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
    });

  const emailInvitations = invitations
    .filter((invitation) => invitation.channel === "email")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const smsInvitations = invitations
    .filter((invitation) => invitation.channel === "sms")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const whatsappInvitations = invitations
    .filter((invitation) => invitation.channel === "whatsapp")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const responseTone = response ? (response.attending ? "live" : "fail") : "wait";
  const responseLabel = response ? (response.attending ? "attending" : "declined") : "pending";
  const channels = [
    emailAvailable ? "email" : null,
    smsAvailable ? "sms" : null,
    whatsappAvailable ? "whatsapp" : null,
  ].filter((value): value is string => value !== null);
  const channelReadiness = buildInviteeChannelReadiness({
    campaign,
    invitee,
    providers: {
      emailEnabled: isChannelProviderEnabled("email"),
      smsEnabled: isChannelProviderEnabled("sms"),
      whatsappEnabled: isChannelProviderEnabled("whatsapp"),
    },
  });

  return (
    <Drawer
      title={invitee.fullName}
      crumb={[invitee.title, invitee.organization].filter(Boolean).join(" - ") || undefined}
      closeHref={closeHref}
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <form action={deleteAction}>
            <input type="hidden" name="inviteeId" value={invitee.id} />
            <ConfirmButton
              prompt={`Remove ${invitee.fullName} from ${campaign.name}? Their response (if any) is deleted too.`}
            >
              Delete invitee
            </ConfirmButton>
          </form>
          <div className="flex flex-wrap gap-2">
            {emailAvailable ? (
              <Link
                href={`/campaigns/${campaign.id}/invitees/${invitee.id}/preview/email`}
                target="_blank"
                className="btn-ghost text-xs"
              >
                Preview email
              </Link>
            ) : null}
            {smsAvailable ? (
              <Link
                href={`/campaigns/${campaign.id}/invitees/${invitee.id}/preview/sms`}
                target="_blank"
                className="btn-ghost text-xs"
              >
                Preview SMS
              </Link>
            ) : null}
            {whatsappAvailable ? (
              <Link
                href={`/campaigns/${campaign.id}/invitees/${invitee.id}/preview/whatsapp`}
                target="_blank"
                className="btn-ghost text-xs"
              >
                Preview WhatsApp
              </Link>
            ) : null}
            <Link
              href={`/campaigns/${campaign.id}/invitees/${invitee.id}/edit`}
              className="btn-ghost text-xs"
            >
              Add or edit contact info
            </Link>
            <form action={resendAction} className="inline-flex flex-wrap gap-2">
              <input type="hidden" name="inviteeId" value={invitee.id} />
              {emailAvailable ? (
                <button name="channel" value="email" className="btn-primary text-xs">
                  Resend email
                </button>
              ) : null}
              {smsAvailable ? (
                <button name="channel" value="sms" className="btn-primary text-xs">
                  Resend SMS
                </button>
              ) : null}
              {whatsappAvailable ? (
                <button name="channel" value="whatsapp" className="btn-primary text-xs">
                  Resend WhatsApp
                </button>
              ) : null}
            </form>
          </div>
        </div>
      }
    >
      <section className="grid grid-cols-2 gap-6">
        <Kv label="Email" value={invitee.email ?? "--"} mono />
        <Kv label="Phone" value={invitee.phoneE164 ?? "--"} mono />
        <Kv label="Locale" value={invitee.locale ?? `${campaign.locale} (campaign)`} />
        <Kv label="Guests allowed" value={String(invitee.guestsAllowed)} />
        <Kv label="Channels" value={channels.length > 0 ? channels.join(" - ") : "--"} />
        <Kv label="Added" value={fmt.format(invitee.createdAt)} />
        <Kv label="Tags" value={invitee.tags || "--"} />
      </section>

      <section className="mt-6">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-ink-400">Available send options</div>
        <div className="grid grid-cols-1 gap-2">
          {channelReadiness.map((channel) => (
            <div
              key={channel.channel}
              className="flex items-start justify-between gap-3 rounded-lg border border-ink-100 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-sm text-ink-900">{channel.label}</div>
                <div className="mt-0.5 text-xs text-ink-500">{channel.reason}</div>
                {channel.detail ? (
                  <div className="mt-0.5 truncate text-xs text-ink-400">{channel.detail}</div>
                ) : null}
              </div>
              <Badge tone={channel.ready ? "live" : "hold"}>
                {channel.ready ? "ready" : "unavailable"}
              </Badge>
            </div>
          ))}
        </div>
      </section>

      {invitee.notes ? (
        <section className="mt-6">
          <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-400">Notes</div>
          <p className="whitespace-pre-wrap text-sm text-ink-700">{invitee.notes}</p>
        </section>
      ) : null}

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider text-ink-400">Response</div>
          <Badge tone={responseTone}>{responseLabel}</Badge>
        </div>
        {response ? (
          <div className="mt-2 text-sm text-ink-700">
            <div>
              {response.attending ? "Attending" : "Not attending"}
              {response.attending && response.guestsCount > 0 ? ` - ${response.guestsCount} guest${response.guestsCount === 1 ? "" : "s"}` : ""}
            </div>
            {chosenDate ? (
              <div className="mt-1 text-xs text-ink-500">
                Picked: <span className="tabular-nums text-ink-900">{fmt.format(chosenDate.startsAt)}</span>
                {chosenDate.label ? <span className="text-ink-400"> - {chosenDate.label}</span> : null}
              </div>
            ) : null}
            <div className="mt-0.5 text-xs text-ink-400">{fmt.format(response.respondedAt)}</div>
            {response.guestNames ? (
              <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2">
                <div className="mb-1 text-micro uppercase text-ink-500">Guests</div>
                <ul className="space-y-0.5 text-body text-ink-800">
                  {response.guestNames.split(/\r?\n/).filter(Boolean).map((name, index) => (
                    <li key={index} className="tabular-nums">
                      <span className="me-2 text-ink-400">{index + 1}.</span>
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {response.message ? (
              <p className="mt-2 whitespace-pre-wrap border-l-2 border-ink-200 pl-3 text-sm text-ink-600">
                {response.message}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {response && questions.length > 0 ? (
        <section className="mt-8">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-ink-400">Answers</div>
          <dl className="grid grid-cols-1 gap-3">
            {questions.map((question) => {
              const value = answerByQuestion.get(question.id);
              return (
                <div key={question.id} className="border-l-2 border-ink-100 pl-3">
                  <dt className="text-xs text-ink-500">{question.prompt}</dt>
                  <dd className="whitespace-pre-wrap text-sm text-ink-900">
                    {value ? value : <span className="text-ink-300">--</span>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ) : null}

      <section className="mt-8">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-ink-400">RSVP link</div>
        <input readOnly value={rsvpUrl} className="field select-all font-mono text-xs" />
      </section>

      <section className="mt-8 grid grid-cols-3 gap-6">
        <ChannelHistory label="Email" items={emailInvitations} />
        <ChannelHistory label="SMS" items={smsInvitations} />
        <ChannelHistory label="WhatsApp" items={whatsappInvitations} />
      </section>
    </Drawer>
  );
}

function Kv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className={`mt-0.5 text-sm text-ink-900 ${mono ? "font-mono tabular-nums" : ""}`}>{value}</div>
    </div>
  );
}

function ChannelHistory({ label, items }: { label: string; items: Invitation[] }) {
  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-wider text-ink-400">{label}</div>
      {items.length === 0 ? (
        <div className="text-xs text-ink-400">No attempts.</div>
      ) : (
        <ul className="space-y-2">
          {items.slice(0, 5).map((invitation) => {
            const tone = statusTone[invitation.status as keyof typeof statusTone] ?? "muted";
            return (
              <li key={invitation.id} className="flex items-start justify-between text-xs">
                <div>
                  <Badge tone={tone}>{invitation.status}</Badge>
                  {invitation.error ? (
                    <div className="mt-1 max-w-[16rem] whitespace-pre-wrap break-words text-ink-400">
                      {invitation.error}
                    </div>
                  ) : null}
                </div>
                <div className="tabular-nums text-ink-400">{fmt.format(invitation.createdAt)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
