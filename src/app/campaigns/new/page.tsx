import { redirect } from "next/navigation";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { parseLocalInput } from "@/lib/time";

export const dynamic = "force-dynamic";

async function createCampaign(formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const name = String(formData.get("name") ?? "").trim().slice(0, 200);
  if (!name) return;
  const rawLocale = String(formData.get("locale") ?? "en").toLowerCase();
  const locale = rawLocale === "ar" ? "ar" : "en";
  const c = await prisma.campaign.create({
    data: {
      name,
      description: String(formData.get("description") ?? "").trim().slice(0, 2000) || null,
      venue: String(formData.get("venue") ?? "").trim().slice(0, 200) || null,
      locale,
      eventAt: parseLocalInput(String(formData.get("eventAt") ?? "")),
      rsvpDeadline: parseLocalInput(String(formData.get("rsvpDeadline") ?? "")),
      subjectEmail: String(formData.get("subjectEmail") ?? "").trim().slice(0, 300) || null,
      templateEmail: String(formData.get("templateEmail") ?? "").trim().slice(0, 5000) || null,
      templateSms: String(formData.get("templateSms") ?? "").trim().slice(0, 500) || null,
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
