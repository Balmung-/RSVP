import type { Template } from "@prisma/client";
import { TEMPLATE_KINDS, type TemplateKind } from "@/lib/templates";

export function TemplateForm({
  template,
  action,
  submitLabel,
  cancelHref,
  defaultKind,
}: {
  template?: Template | null;
  action: (fd: FormData) => Promise<void> | void;
  submitLabel: string;
  cancelHref: string;
  defaultKind?: TemplateKind;
}) {
  const kind = template?.kind ?? defaultKind ?? "email";
  return (
    <form action={action} className="panel p-10 max-w-3xl grid grid-cols-2 gap-6">
      <Field label="Name" className="col-span-2">
        <input
          name="name"
          className="field"
          required
          maxLength={120}
          defaultValue={template?.name ?? ""}
          placeholder="Diplomatic reception — email (EN)"
        />
      </Field>
      <Field label="Kind">
        <select name="kind" className="field" defaultValue={kind}>
          {TEMPLATE_KINDS.map((k) => (
            <option key={k} value={k}>{k.toUpperCase()}</option>
          ))}
        </select>
      </Field>
      <Field label="Locale">
        <select name="locale" className="field" defaultValue={template?.locale ?? "en"}>
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </select>
      </Field>
      <Field label="Email subject (email only)" className="col-span-2">
        <input
          name="subject"
          className="field"
          maxLength={300}
          defaultValue={template?.subject ?? ""}
          placeholder="Invitation — {{campaign}}"
        />
      </Field>
      <Field label="Body" className="col-span-2">
        <textarea
          name="body"
          rows={8}
          className="field font-mono text-xs"
          required
          maxLength={10000}
          defaultValue={template?.body ?? ""}
        />
      </Field>
      <p className="col-span-2 text-mini text-ink-400 -mt-3">
        Tokens: <code>{"{{name}}"}</code> <code>{"{{title}}"}</code> <code>{"{{campaign}}"}</code>{" "}
        <code>{"{{venue}}"}</code> <code>{"{{eventAt}}"}</code> <code>{"{{rsvpUrl}}"}</code>{" "}
        <code>{"{{brand}}"}</code>. Wrap in <code>{"{{#venue}}...{{/venue}}"}</code> to hide a block
        when the value is empty.
      </p>
      <Field label="Tags" className="col-span-2">
        <input
          name="tags"
          className="field"
          maxLength={300}
          defaultValue={template?.tags ?? ""}
          placeholder="national-day, reception, diplomatic"
        />
      </Field>
      <div className="col-span-2 flex items-center justify-end gap-3 pt-2">
        <a href={cancelHref} className="btn btn-ghost">Cancel</a>
        <button className="btn btn-primary">{submitLabel}</button>
      </div>
    </form>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-micro uppercase text-ink-400">{label}</span>
      {children}
    </label>
  );
}
