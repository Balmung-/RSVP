import type { Contact } from "@prisma/client";
import { VIP_TIERS, VIP_LABEL } from "@/lib/contacts";

export function ContactForm({
  contact,
  action,
  submitLabel,
  cancelHref,
}: {
  contact?: Contact | null;
  action: (fd: FormData) => Promise<void> | void;
  submitLabel: string;
  cancelHref: string;
}) {
  return (
    <form action={action} className="panel p-10 max-w-3xl grid grid-cols-2 gap-6">
      <Field label="Full name" className="col-span-2">
        <input
          name="fullName"
          className="field"
          required
          maxLength={200}
          defaultValue={contact?.fullName ?? ""}
          placeholder="H.E. Dr. Saad Al-Faisal"
        />
      </Field>
      <Field label="Title">
        <input
          name="title"
          className="field"
          maxLength={100}
          defaultValue={contact?.title ?? ""}
          placeholder="Minister"
        />
      </Field>
      <Field label="Organization">
        <input
          name="organization"
          className="field"
          maxLength={200}
          defaultValue={contact?.organization ?? ""}
          placeholder="Ministry of Culture"
        />
      </Field>
      <Field label="Email">
        <input
          name="email"
          type="email"
          className="field"
          maxLength={300}
          defaultValue={contact?.email ?? ""}
        />
      </Field>
      <Field label="Phone">
        <input
          name="phone"
          className="field"
          maxLength={50}
          defaultValue={contact?.phoneE164 ?? ""}
          placeholder="+966 50 123 4567"
        />
      </Field>
      <Field label="Preferred language">
        <select name="preferredLocale" className="field" defaultValue={contact?.preferredLocale ?? ""}>
          <option value="">Not specified</option>
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </select>
      </Field>
      <Field label="VIP tier">
        <select name="vipTier" className="field" defaultValue={contact?.vipTier ?? "standard"}>
          {VIP_TIERS.map((t) => (
            <option key={t} value={t}>{VIP_LABEL[t]}</option>
          ))}
        </select>
      </Field>
      <Field label="Tags" className="col-span-2">
        <input
          name="tags"
          className="field"
          maxLength={500}
          defaultValue={contact?.tags ?? ""}
          placeholder="diplomat, royal, returning-guest"
        />
      </Field>
      <Field label="Dietary">
        <input
          name="dietary"
          className="field"
          maxLength={500}
          defaultValue={contact?.dietary ?? ""}
          placeholder="Vegetarian · halal · no shellfish"
        />
      </Field>
      <Field label="Dress">
        <input
          name="dress"
          className="field"
          maxLength={200}
          defaultValue={contact?.dress ?? ""}
          placeholder="Formal · traditional"
        />
      </Field>
      <Field label="Security notes" className="col-span-2">
        <textarea
          name="securityNotes"
          rows={2}
          className="field"
          maxLength={1000}
          defaultValue={contact?.securityNotes ?? ""}
          placeholder="Protection detail contact, access requirements, etc."
        />
      </Field>
      <Field label="Notes" className="col-span-2">
        <textarea
          name="notes"
          rows={3}
          className="field"
          maxLength={2000}
          defaultValue={contact?.notes ?? ""}
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
