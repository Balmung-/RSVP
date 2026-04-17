import { redirect } from "next/navigation";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function createCampaign(formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const eventAtRaw = String(formData.get("eventAt") ?? "");
  const rsvpDeadlineRaw = String(formData.get("rsvpDeadline") ?? "");
  const c = await prisma.campaign.create({
    data: {
      name,
      description: String(formData.get("description") ?? "").trim() || null,
      venue: String(formData.get("venue") ?? "").trim() || null,
      locale: (String(formData.get("locale") ?? "en") as "en" | "ar"),
      eventAt: eventAtRaw ? new Date(eventAtRaw) : null,
      rsvpDeadline: rsvpDeadlineRaw ? new Date(rsvpDeadlineRaw) : null,
      subjectEmail: String(formData.get("subjectEmail") ?? "").trim() || null,
      templateEmail: String(formData.get("templateEmail") ?? "").trim() || null,
      templateSms: String(formData.get("templateSms") ?? "").trim() || null,
    },
  });
  redirect(`/campaigns/${c.id}`);
}

export default function NewCampaign() {
  if (!isAuthed()) redirect("/login");
  return (
    <Shell title="New campaign" crumb={<Link href="/">Campaigns</Link>}>
      <form action={createCampaign} className="panel max-w-3xl p-10 grid grid-cols-2 gap-6">
        <Field label="Name" className="col-span-2">
          <input name="name" className="field" required placeholder="National Day Reception 2026" />
        </Field>
        <Field label="Venue">
          <input name="venue" className="field" placeholder="Diplomatic Quarter, Riyadh" />
        </Field>
        <Field label="Locale">
          <select name="locale" className="field" defaultValue="en">
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </select>
        </Field>
        <Field label="Event date & time">
          <input name="eventAt" type="datetime-local" className="field" />
        </Field>
        <Field label="RSVP deadline">
          <input name="rsvpDeadline" type="datetime-local" className="field" />
        </Field>
        <Field label="Description" className="col-span-2">
          <textarea name="description" rows={2} className="field" />
        </Field>
        <details className="col-span-2 group">
          <summary className="cursor-pointer text-sm text-ink-500 select-none py-2">
            Templates (optional — defaults are used if left blank)
          </summary>
          <div className="mt-4 grid grid-cols-2 gap-6">
            <Field label="Email subject" className="col-span-2">
              <input name="subjectEmail" className="field" placeholder="Invitation — {{campaign}}" />
            </Field>
            <Field label="Email body" className="col-span-2">
              <textarea name="templateEmail" rows={5} className="field font-mono text-xs" />
            </Field>
            <Field label="SMS body" className="col-span-2">
              <textarea name="templateSms" rows={2} className="field font-mono text-xs" />
            </Field>
            <p className="col-span-2 text-xs text-ink-400">
              Tokens: <code>{"{{name}}"}</code> <code>{"{{title}}"}</code> <code>{"{{campaign}}"}</code>{" "}
              <code>{"{{venue}}"}</code> <code>{"{{eventAt}}"}</code> <code>{"{{rsvpUrl}}"}</code>{" "}
              <code>{"{{brand}}"}</code>
            </p>
          </div>
        </details>
        <div className="col-span-2 flex items-center justify-end gap-3 pt-2">
          <Link href="/" className="btn-ghost">Cancel</Link>
          <button className="btn-primary">Create campaign</button>
        </div>
      </form>
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
