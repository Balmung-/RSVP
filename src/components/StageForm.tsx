import type { CampaignStage } from "@prisma/client";
import { toLocalInput } from "@/lib/time";
import { STAGE_KINDS, AUDIENCE_KINDS } from "@/lib/stages";

// Shared between add/edit stage. Thin form — parsing + normalization happen
// in the server action so this stays dumb.

export function StageForm({
  stage,
  action,
  submitLabel,
  cancelHref,
}: {
  stage?: CampaignStage | null;
  action: (fd: FormData) => Promise<void> | void;
  submitLabel: string;
  cancelHref: string;
}) {
  const channelsSet = new Set((stage?.channels ?? "email,sms").split(",").map((s) => s.trim()));
  return (
    <form action={action} className="grid grid-cols-2 gap-6">
      <Field label="Kind">
        <select name="kind" className="field" defaultValue={stage?.kind ?? "invite"}>
          {STAGE_KINDS.map((k) => (
            <option key={k} value={k}>{k.replace("_", " ")}</option>
          ))}
        </select>
      </Field>
      <Field label="Label (optional)">
        <input
          name="name"
          className="field"
          maxLength={100}
          defaultValue={stage?.name ?? ""}
          placeholder="T-5 reminder"
        />
      </Field>
      <Field label="Fire at">
        <input
          name="scheduledFor"
          type="datetime-local"
          className="field"
          required
          defaultValue={toLocalInput(stage?.scheduledFor) || toLocalInput(new Date(Date.now() + 3600_000))}
        />
      </Field>
      <Field label="Audience">
        <select name="audience" className="field" defaultValue={stage?.audience ?? "all"}>
          {AUDIENCE_KINDS.map((k) => (
            <option key={k} value={k}>{k.replace("_", " ")}</option>
          ))}
        </select>
      </Field>
      <Field label="Channels" className="col-span-2">
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="channel_email" defaultChecked={channelsSet.has("email")} className="accent-ink-900" />
            <span>Email</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="channel_sms" defaultChecked={channelsSet.has("sms")} className="accent-ink-900" />
            <span>SMS</span>
          </label>
        </div>
      </Field>
      <details className="col-span-2 group" open={!!(stage?.subjectEmail || stage?.templateEmail || stage?.templateSms)}>
        <summary className="cursor-pointer text-sm text-ink-500 select-none py-2">
          Template overrides (blank = use campaign defaults)
        </summary>
        <div className="mt-4 grid grid-cols-2 gap-6">
          <Field label="Email subject" className="col-span-2">
            <input
              name="subjectEmail"
              className="field"
              maxLength={300}
              defaultValue={stage?.subjectEmail ?? ""}
              placeholder="Reminder — {{campaign}}"
            />
          </Field>
          <Field label="Email body" className="col-span-2">
            <textarea
              name="templateEmail"
              rows={6}
              className="field font-mono text-xs"
              maxLength={5000}
              defaultValue={stage?.templateEmail ?? ""}
            />
          </Field>
          <Field label="SMS body" className="col-span-2">
            <textarea
              name="templateSms"
              rows={2}
              className="field font-mono text-xs"
              maxLength={500}
              defaultValue={stage?.templateSms ?? ""}
            />
          </Field>
        </div>
      </details>
      <div className="col-span-2 flex items-center justify-end gap-3 pt-2">
        <a href={cancelHref} className="btn-ghost">Cancel</a>
        <button className="btn-primary">{submitLabel}</button>
      </div>
    </form>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-[11px] uppercase tracking-wider text-ink-400">{label}</span>
      {children}
    </label>
  );
}
