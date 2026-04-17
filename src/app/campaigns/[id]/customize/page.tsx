import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ConfirmButton } from "@/components/ConfirmButton";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import {
  listQuestions,
  createQuestion,
  deleteQuestion,
  QUESTION_KINDS,
  SHOW_WHEN,
  type QuestionKind,
  type ShowWhen,
  needsOptions,
} from "@/lib/questions";
import {
  listAttachments,
  createAttachment,
  deleteAttachment,
  ATTACHMENT_KINDS,
  type AttachmentKind,
  isSafeUrl,
} from "@/lib/attachments";
import {
  listEventOptions,
  createEventOption,
  deleteEventOption,
} from "@/lib/eventoptions";
import { parseLocalInput } from "@/lib/time";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const dateFmt = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TZ,
});

// --- actions ------------------------------------------------------

async function addQuestion(campaignId: string, formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const kindRaw = String(formData.get("kind") ?? "short_text");
  const kind = (QUESTION_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as QuestionKind) : "short_text";
  const showRaw = String(formData.get("showWhen") ?? "always");
  const showWhen = (SHOW_WHEN as readonly string[]).includes(showRaw) ? (showRaw as ShowWhen) : "always";
  const prompt = String(formData.get("prompt") ?? "").trim();
  if (!prompt) redirect(`/campaigns/${campaignId}/customize`);
  await createQuestion(campaignId, {
    prompt,
    kind,
    required: formData.get("required") === "on",
    options: String(formData.get("options") ?? ""),
    showWhen,
  });
  redirect(`/campaigns/${campaignId}/customize`);
}

async function removeQuestion(campaignId: string, formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const id = String(formData.get("questionId"));
  if (id) await deleteQuestion(id, campaignId);
  redirect(`/campaigns/${campaignId}/customize`);
}

async function addAttachment(campaignId: string, formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const kindRaw = String(formData.get("kind") ?? "file");
  const kind = (ATTACHMENT_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as AttachmentKind) : "file";
  const label = String(formData.get("label") ?? "").trim();
  const url = String(formData.get("url") ?? "").trim();
  if (!label || !isSafeUrl(url)) redirect(`/campaigns/${campaignId}/customize?e=att`);
  await createAttachment(campaignId, { label, url, kind });
  redirect(`/campaigns/${campaignId}/customize`);
}

async function removeAttachment(campaignId: string, formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const id = String(formData.get("attachmentId"));
  if (id) await deleteAttachment(id, campaignId);
  redirect(`/campaigns/${campaignId}/customize`);
}

async function addDate(campaignId: string, formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const startsAt = parseLocalInput(String(formData.get("startsAt") ?? ""));
  if (!startsAt) redirect(`/campaigns/${campaignId}/customize?e=date`);
  await createEventOption(campaignId, {
    startsAt: startsAt!,
    endsAt: parseLocalInput(String(formData.get("endsAt") ?? "")),
    label: String(formData.get("label") ?? "").trim() || null,
    venue: String(formData.get("venue") ?? "").trim() || null,
  });
  redirect(`/campaigns/${campaignId}/customize`);
}

async function removeDate(campaignId: string, formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const id = String(formData.get("eventOptionId"));
  if (id) await deleteEventOption(id, campaignId);
  redirect(`/campaigns/${campaignId}/customize`);
}

// --- page ---------------------------------------------------------

export default async function Customize({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { e?: string };
}) {
  if (!isAuthed()) redirect("/login");
  const c = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!c) notFound();
  const [questions, attachments, dates] = await Promise.all([
    listQuestions(c.id),
    listAttachments(c.id),
    listEventOptions(c.id),
  ]);

  const boundAddQ = addQuestion.bind(null, c.id);
  const boundRmQ = removeQuestion.bind(null, c.id);
  const boundAddA = addAttachment.bind(null, c.id);
  const boundRmA = removeAttachment.bind(null, c.id);
  const boundAddD = addDate.bind(null, c.id);
  const boundRmD = removeDate.bind(null, c.id);

  const err =
    searchParams.e === "att"
      ? "Attachment needs a label and a valid http(s) URL."
      : searchParams.e === "date"
        ? "Pick a valid start date/time."
        : null;

  return (
    <Shell
      title="Customize"
      crumb={
        <span>
          <Link href="/" className="hover:underline">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Customize</span>
        </span>
      }
    >
      {err ? <p role="alert" className="text-sm text-signal-fail mb-6 max-w-3xl">{err}</p> : null}

      {/* ---------- Event dates ---------- */}
      <section className="max-w-3xl mb-12">
        <h2 className="text-sm font-medium tracking-tight text-ink-900">Event dates</h2>
        <p className="text-xs text-ink-400 mb-4">
          Add one or more dates. When multiple, invitees pick the one they can attend on the RSVP page.
          If empty, the campaign&rsquo;s main date (on the campaign settings) is used.
        </p>

        <form action={boundAddD} className="panel p-6 grid grid-cols-2 gap-4 mb-4">
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

        {dates.length > 0 ? (
          <ul className="panel divide-y divide-ink-100 overflow-hidden">
            {dates.map((d) => (
              <li key={d.id} className="flex items-center justify-between px-6 py-3">
                <div className="text-sm text-ink-900 tabular-nums">
                  {dateFmt.format(d.startsAt)}
                  {d.endsAt ? <> <span className="text-ink-400">→</span> {dateFmt.format(d.endsAt)}</> : null}
                  {d.venue ? <span className="text-ink-400"> · {d.venue}</span> : null}
                  {d.label ? <span className="text-ink-400"> · {d.label}</span> : null}
                </div>
                <form action={boundRmD}>
                  <input type="hidden" name="eventOptionId" value={d.id} />
                  <ConfirmButton prompt="Remove this date option?">Remove</ConfirmButton>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* ---------- Attachments ---------- */}
      <section className="max-w-3xl mb-12">
        <h2 className="text-sm font-medium tracking-tight text-ink-900">Attachments</h2>
        <p className="text-xs text-ink-400 mb-4">
          Shown on the RSVP page. Hosted elsewhere (paste a public URL).
        </p>

        <form action={boundAddA} className="panel p-6 grid grid-cols-2 gap-4 mb-4">
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

        {attachments.length > 0 ? (
          <ul className="panel divide-y divide-ink-100 overflow-hidden">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center justify-between px-6 py-3">
                <div>
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
                <div className="flex items-center gap-3">
                  <span className="text-[11px] uppercase tracking-wider text-ink-400">{a.kind}</span>
                  <form action={boundRmA}>
                    <input type="hidden" name="attachmentId" value={a.id} />
                    <ConfirmButton prompt={`Remove "${a.label}"?`}>Remove</ConfirmButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* ---------- Questions ---------- */}
      <section className="max-w-3xl">
        <h2 className="text-sm font-medium tracking-tight text-ink-900">Custom questions</h2>
        <p className="text-xs text-ink-400 mb-4">
          Shown on the RSVP page. Use sparingly — every extra field lowers completion.
        </p>

        <form action={boundAddQ} className="panel p-6 grid grid-cols-2 gap-4 mb-4">
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
              <option value="always">Always</option>
              <option value="attending">When attending</option>
              <option value="declined">When declined</option>
            </select>
          </Field>
          <Field label="Options (one per line — for selects)" className="col-span-2">
            <textarea name="options" rows={3} className="field font-mono text-xs" placeholder={"None\nVegetarian\nHalal\nGluten-free"} />
          </Field>
          <div className="col-span-2 flex items-center justify-between">
            <label className="text-xs text-ink-600 flex items-center gap-2">
              <input type="checkbox" name="required" className="accent-ink-900" />
              Required
            </label>
            <button className="btn-primary text-xs">Add question</button>
          </div>
        </form>

        {questions.length > 0 ? (
          <ul className="panel divide-y divide-ink-100 overflow-hidden">
            {questions.map((q) => (
              <li key={q.id} className="flex items-start justify-between px-6 py-3">
                <div className="min-w-0 pr-4">
                  <div className="text-sm text-ink-900">{q.prompt}</div>
                  <div className="text-xs text-ink-400 mt-0.5">
                    {q.kind.replace("_", " ")}
                    {q.required ? <> · required</> : null}
                    {" · "}shown {q.showWhen}
                    {needsOptions(q.kind as QuestionKind) && q.options
                      ? <> · {q.options.split(/\r?\n/).filter(Boolean).length} options</>
                      : null}
                  </div>
                </div>
                <form action={boundRmQ}>
                  <input type="hidden" name="questionId" value={q.id} />
                  <ConfirmButton prompt={`Remove "${q.prompt}"? Existing answers are also deleted.`}>
                    Remove
                  </ConfirmButton>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </Shell>
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
