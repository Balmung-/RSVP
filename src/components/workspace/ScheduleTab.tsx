import Link from "next/link";
import type { CampaignStage } from "@prisma/client";
import { StageTimeline } from "@/components/StageTimeline";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmtShort = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TZ,
});

export function ScheduleTab({
  campaignId,
  stages,
  eventAt,
  runNowAction,
  addReminderAction,
  canWrite,
}: {
  campaignId: string;
  stages: CampaignStage[];
  eventAt: Date | null;
  runNowAction: (fd: FormData) => Promise<void> | void;
  addReminderAction: (fd: FormData) => Promise<void> | void;
  canWrite: boolean;
}) {
  const quickAdd = canWrite && eventAt ? (
    <QuickReminder eventAt={eventAt} action={addReminderAction} />
  ) : null;

  if (stages.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {quickAdd}
        <EmptyState
          icon="clock"
          title="No stages scheduled"
          action={
            canWrite
              ? { label: "Add the first stage", href: `/campaigns/${campaignId}/stages/new` }
              : undefined
          }
        >
          Stages fire automatically. Chain them to build the flow:
          invitation → reminder → last call → thank-you.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {canWrite ? (
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sub text-ink-900">Send schedule</h2>
            <p className="text-body text-ink-500 mt-1 max-w-lg">
              Queue invitations, reminders, last calls, and thank-yous to fire automatically.
              The cron worker wakes each stage at its scheduled time.
            </p>
          </div>
          <Link href={`/campaigns/${campaignId}/stages/new`} className="btn btn-primary">
            <Icon name="plus" size={14} />
            Add stage
          </Link>
        </div>
      ) : null}

      {quickAdd}

      <StageTimeline campaignId={campaignId} stages={stages} runNowAction={runNowAction} />
    </div>
  );
}

// Offsets that cover the common protocol-office cadence: week out, day
// out, afternoon-of, hour-of. Kept small so the panel stays calm.
const REMINDER_OFFSETS: Array<{ hours: number; label: string }> = [
  { hours: 168, label: "1 week before" },
  { hours: 24, label: "24 h before" },
  { hours: 4, label: "4 h before" },
  { hours: 1, label: "1 h before" },
];

function QuickReminder({
  eventAt,
  action,
}: {
  eventAt: Date;
  action: (fd: FormData) => Promise<void> | void;
}) {
  const now = Date.now();
  return (
    <form
      action={action}
      className="panel-quiet p-5 flex flex-wrap items-center gap-3 max-w-3xl"
    >
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <span className="h-9 w-9 rounded-md bg-ink-100 text-ink-500 grid place-items-center shrink-0 mt-0.5">
          <Icon name="clock" size={15} />
        </span>
        <div className="min-w-0">
          <div className="text-body text-ink-900">Quick reminder</div>
          <p className="text-mini text-ink-500 mt-0.5 leading-relaxed">
            Nudge anyone who hasn&apos;t replied yet. Event{" "}
            <span className="tabular-nums">{fmtShort.format(eventAt)}</span>.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2">
          <span className="sr-only">Offset</span>
          <select name="hoursBefore" defaultValue="24" className="field !py-1.5 text-mini">
            {REMINDER_OFFSETS.map((o) => {
              const scheduled = eventAt.getTime() - o.hours * 3600_000;
              const past = scheduled < now - 60_000;
              return (
                <option key={o.hours} value={o.hours} disabled={past}>
                  {o.label}
                  {past ? " (past)" : ""}
                </option>
              );
            })}
          </select>
        </label>
        <button className="btn btn-soft text-mini">
          <Icon name="plus" size={13} />
          Add reminder
        </button>
      </div>
    </form>
  );
}
