import type { Invitee } from "@prisma/client";
import { Field } from "./Field";

// Shared between /invitees/new and /invitees/[id]/edit.
// The form emits raw strings — validation + normalization live in the action.

export function InviteeForm({
  invitee,
  action,
  submitLabel,
  cancelHref,
}: {
  invitee?: Invitee | null;
  action: (fd: FormData) => Promise<void> | void;
  submitLabel: string;
  cancelHref: string;
}) {
  return (
    <form action={action} className="grid grid-cols-2 gap-6">
      <Field label="Full name" className="col-span-2">
        <input
          name="fullName"
          className="field"
          required
          maxLength={200}
          defaultValue={invitee?.fullName ?? ""}
          placeholder="H.E. Dr. Saad Al-Faisal"
        />
      </Field>
      <Field label="Title">
        <input
          name="title"
          className="field"
          maxLength={100}
          defaultValue={invitee?.title ?? ""}
          placeholder="Minister"
        />
      </Field>
      <Field label="Organization">
        <input
          name="organization"
          className="field"
          maxLength={200}
          defaultValue={invitee?.organization ?? ""}
          placeholder="Ministry of Culture"
        />
      </Field>
      <Field label="Email">
        <input
          name="email"
          type="email"
          className="field"
          maxLength={300}
          defaultValue={invitee?.email ?? ""}
          placeholder="name@example.gov.sa"
        />
      </Field>
      <Field label="Phone">
        <input
          name="phone"
          className="field"
          maxLength={50}
          defaultValue={invitee?.phoneE164 ?? ""}
          placeholder="+966 50 123 4567"
        />
      </Field>
      <Field label="Locale">
        <select name="locale" className="field" defaultValue={invitee?.locale ?? ""}>
          <option value="">Default (campaign)</option>
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </select>
      </Field>
      <Field label="Guests allowed">
        <input
          name="guestsAllowed"
          type="number"
          min={0}
          max={20}
          className="field"
          defaultValue={invitee?.guestsAllowed ?? 0}
        />
      </Field>
      <Field label="Tags" className="col-span-2">
        <input
          name="tags"
          className="field"
          maxLength={500}
          defaultValue={invitee?.tags ?? ""}
          placeholder="vip, diplomat"
        />
      </Field>
      <Field label="Notes" className="col-span-2">
        <textarea
          name="notes"
          rows={2}
          className="field"
          maxLength={2000}
          defaultValue={invitee?.notes ?? ""}
        />
      </Field>
      <div className="col-span-2 flex items-center justify-end gap-3 pt-2">
        <a href={cancelHref} className="btn-ghost">Cancel</a>
        <button className="btn-primary">{submitLabel}</button>
      </div>
    </form>
  );
}

