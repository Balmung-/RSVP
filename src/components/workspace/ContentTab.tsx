import type { CampaignAttachment, CampaignQuestion, EventOption } from "@prisma/client";
import { ConfirmButton } from "@/components/ConfirmButton";
import { QUESTION_KINDS, SHOW_WHEN, needsOptions } from "@/lib/questions";
import { ATTACHMENT_KINDS } from "@/lib/attachments";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const dateFmt = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TZ,
});

export function ContentTab({
  canWrite,
  questions,
  attachments,
  dates,
  datePickCounts,
  addQuestionAction,
  removeQuestionAction,
  addAttachmentAction,
  removeAttachmentAction,
  addDateAction,
  removeDateAction,
  error,
}: {
  canWrite: boolean;
  questions: CampaignQuestion[];
  attachments: CampaignAttachment[];
  dates: EventOption[];
  datePickCounts: Map<string, number>;
  addQuestionAction: (fd: FormData) => Promise<void> | void;
  removeQuestionAction: (fd: FormData) => Promise<void> | void;
  addAttachmentAction: (fd: FormData) => Promise<void> | void;
  removeAttachmentAction: (fd: FormData) => Promise<void> | void;
  addDateAction: (fd: FormData) => Promise<void> | void;
  removeDateAction: (fd: FormData) => Promise<void> | void;
  error: string | null;
}) {
  return (
    <div className="max-w-3xl flex flex-col gap-12">
      {error ? <p role="alert" className="text-sm text-signal-fail">{error}</p> : null}

      <Section
        title="Event dates"
        hint="When multiple dates are set, invitees pick one on the RSVP page. Otherwise the campaign's main date is used."
      >
        {canWrite ? (
          <form action={addDateAction} className="panel p-5 grid grid-cols-2 gap-4 mb-3">
            <Field label="Starts at">
              <input name="startsAt" type="datetime-local" className="field" required />
            </Field>
            <Field label="Ends at (optional)">
              <input name="endsAt" type="datetime-local" className="field" />
            </Field>
            <Field label="Venue (optional)">
              <input name="venue" className="field" maxLength={200} />
            </Field>
            <Field label="Label (optional)">
              <input name="label" className="field" maxLength={120} placeholder="Day 1" />
            </Field>
            <div className="col-span-2 flex justify-end">
              <button className="btn-primary text-xs">Add date</button>
            </div>
          </form>
        ) : null}

        {dates.length > 0 ? (
          <ul className="panel divide-y divide-ink-100 overflow-hidden">
            {dates.map((d) => {
              const picks = datePickCounts.get(d.id) ?? 0;
              const prompt =
                picks > 0
                  ? `Remove this date? ${picks} response${picks === 1 ? "" : "s"} picked it — those picks will be cleared.`
                  : "Remove this date option?";
              return (
                <li key={d.id} className="flex items-center justify-between px-5 py-3 text-sm">
                  <div className="text-ink-900 tabular-nums">
                    {dateFmt.format(d.startsAt)}
                    {d.endsAt ? <> <span className="text-ink-400">→</span> {dateFmt.format(d.endsAt)}</> : null}
                    {d.venue ? <span className="text-ink-400"> · {d.venue}</span> : null}
                    {d.label ? <span className="text-ink-400"> · {d.label}</span> : null}
                    {picks > 0 ? <span className="text-xs text-ink-500 ms-2">· {picks} picked</span> : null}
                  </div>
                  {canWrite ? (
                    <form action={removeDateAction}>
                      <input type="hidden" name="eventOptionId" value={d.id} />
                      <ConfirmButton prompt={prompt}>Remove</ConfirmButton>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </Section>

      <Section
        title="Attachments"
        hint="Shown on the RSVP page. Host the files anywhere public and paste the URL."
      >
        {canWrite ? (
          <form action={addAttachmentAction} className="panel p-5 grid grid-cols-2 gap-4 mb-3">
            <Field label="Label" className="col-span-2">
              <input name="label" className="field" required maxLength={120} placeholder="Agenda PDF" />
            </Field>
            <Field label="Kind">
              <select name="kind" className="field" defaultValue="file">
                {ATTACHMENT_KINDS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </Field>
            <Field label="URL">
              <input name="url" type="url" className="field" required placeholder="https://..." />
            </Field>
            <div className="col-span-2 flex justify-end">
              <button className="btn-primary text-xs">Add attachment</button>
            </div>
          </form>
        ) : null}

        {attachments.length > 0 ? (
          <ul className="panel divide-y divide-ink-100 overflow-hidden">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center justify-between px-5 py-3">
                <div className="min-w-0">
                  <div className="text-sm text-ink-900">{a.label}</div>
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-ink-500 hover:text-ink-900 font-mono truncate max-w-[40ch] block"
                  >
                    {a.url}
                  </a>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[11px] uppercase tracking-wider text-ink-400">{a.kind}</span>
                  {canWrite ? (
                    <form action={removeAttachmentAction}>
                      <input type="hidden" name="attachmentId" value={a.id} />
                      <ConfirmButton prompt={`Remove "${a.label}"?`}>Remove</ConfirmButton>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section
        title="Custom questions"
        hint="Use sparingly — every extra field lowers completion. Show-when lets you target questions at attending or declined invitees only."
      >
        {canWrite ? (
          <form action={addQuestionAction} className="panel p-5 grid grid-cols-2 gap-4 mb-3">
            <Field label="Prompt" className="col-span-2">
              <input name="prompt" className="field" required maxLength={300} placeholder="Dietary restrictions?" />
            </Field>
            <Field label="Kind">
              <select name="kind" className="field" defaultValue="short_text">
                {QUESTION_KINDS.map((k) => (
                  <option key={k} value={k}>{k.replace("_", " ")}</option>
                ))}
              </select>
            </Field>
            <Field label="Show when">
              <select name="showWhen" className="field" defaultValue="attending">
                {SHOW_WHEN.map((w) => (
                  <option key={w} value={w}>{w.replace("_", " ")}</option>
                ))}
              </select>
            </Field>
            <Field label="Options (one per line — for selects)" className="col-span-2">
              <textarea
                name="options"
                rows={3}
                className="field font-mono text-xs"
                placeholder={"None\nVegetarian\nHalal\nGluten-free"}
              />
            </Field>
            <div className="col-span-2 flex items-center justify-between">
              <label className="text-xs text-ink-600 flex items-center gap-2">
                <input type="checkbox" name="required" className="accent-ink-900" />
                Required
              </label>
              <button className="btn-primary text-xs">Add question</button>
            </div>
          </form>
        ) : null}

        {questions.length > 0 ? (
          <ul className="panel divide-y divide-ink-100 overflow-hidden">
            {questions.map((q) => (
              <li key={q.id} className="flex items-start justify-between px-5 py-3">
                <div className="min-w-0 pr-4">
                  <div className="text-sm text-ink-900">{q.prompt}</div>
                  <div className="text-xs text-ink-400 mt-0.5">
                    {q.kind.replace("_", " ")}
                    {q.required ? <> · required</> : null}
                    {" · "}shown {q.showWhen}
                    {needsOptions(q.kind as Parameters<typeof needsOptions>[0]) && q.options
                      ? <> · {q.options.split(/\r?\n/).filter(Boolean).length} options</>
                      : null}
                  </div>
                </div>
                {canWrite ? (
                  <form action={removeQuestionAction}>
                    <input type="hidden" name="questionId" value={q.id} />
                    <ConfirmButton prompt={`Remove "${q.prompt}"? Existing answers are also deleted.`}>
                      Remove
                    </ConfirmButton>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3">
        <h3 className="text-sm font-medium tracking-tight text-ink-900">{title}</h3>
        <p className="text-xs text-ink-400 mt-1 max-w-lg">{hint}</p>
      </div>
      {children}
    </section>
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
