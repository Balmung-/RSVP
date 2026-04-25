import Link from "next/link";
import type { Campaign, Team } from "@prisma/client";
import { toLocalInput } from "@/lib/time";
import { FileInput } from "./FileInput";
import { Field } from "./Field";
import { WhatsAppCampaignSetup } from "./WhatsAppCampaignSetup";

// One form, two callers. "New" passes no campaign; "Edit" passes the row.
// The submit action is whatever the caller binds - we just collect fields.

export function CampaignForm({
  campaign,
  action,
  submitLabel,
  cancelHref,
  teams,
  whatsappDocumentFilename,
}: {
  campaign?: Partial<Campaign> | null;
  action: (fd: FormData) => Promise<void> | void;
  submitLabel: string;
  cancelHref: string;
  teams?: Team[];
  /**
   * P17-D.3: resolved filename for `campaign.whatsappDocumentUploadId`,
   * passed in by the edit page's server-side render so the operator
   * sees the attached PDF's name instead of the bare cuid. Optional
   * because the new-campaign page has no existing FK to resolve.
   */
  whatsappDocumentFilename?: string | null;
}) {
  return (
    <form action={action} className="panel max-w-3xl p-10 grid grid-cols-2 gap-6">
      <Field label="Name" className="col-span-2">
        <input
          name="name"
          className="field"
          required
          maxLength={200}
          defaultValue={campaign?.name ?? ""}
          placeholder="National Day Reception 2026"
        />
      </Field>
      <Field label="Venue">
        <input
          name="venue"
          className="field"
          maxLength={200}
          defaultValue={campaign?.venue ?? ""}
          placeholder="Diplomatic Quarter, Riyadh"
        />
      </Field>
      {teams && teams.length > 0 ? (
        <Field label="Team">
          <select name="teamId" className="field" defaultValue={campaign?.teamId ?? ""}>
            <option value="">Office-wide</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label="Locale" className={teams && teams.length > 0 ? "" : ""}>
        <select name="locale" className="field" defaultValue={campaign?.locale ?? "en"}>
          <option value="en">English</option>
          <option value="ar">العربية (السعودية)</option>
        </select>
      </Field>
      <Field label="Event date & time">
        <input
          name="eventAt"
          type="datetime-local"
          className="field"
          defaultValue={toLocalInput(campaign?.eventAt)}
        />
      </Field>
      <Field label="RSVP deadline">
        <input
          name="rsvpDeadline"
          type="datetime-local"
          className="field"
          defaultValue={toLocalInput(campaign?.rsvpDeadline)}
        />
      </Field>
      <Field label="Description" className="col-span-2">
        <textarea
          name="description"
          rows={2}
          className="field"
          maxLength={2000}
          defaultValue={campaign?.description ?? ""}
        />
      </Field>
      <details
        className="col-span-2 group"
        open={!!(campaign?.brandColor || campaign?.brandLogoUrl || campaign?.brandHeroUrl)}
      >
        <summary className="cursor-pointer text-sm text-ink-500 select-none py-2">
          Branding - per-campaign logo, hero, accent
        </summary>
        <div className="mt-4 grid grid-cols-2 gap-6">
          <Field label="Accent color (hex)">
            <input
              name="brandColor"
              className="field"
              maxLength={9}
              pattern="^#[0-9A-Fa-f]{3,8}$"
              defaultValue={campaign?.brandColor ?? ""}
              placeholder="#0a6e3d"
            />
          </Field>
          <div />
          <FileInput
            name="brandLogoUrl"
            label="Logo"
            kind="image"
            defaultValue={campaign?.brandLogoUrl ?? ""}
            hint="PNG / JPG / WebP, under 4 MB. Drag in or paste a URL."
          />
          <FileInput
            name="brandHeroUrl"
            label="Hero image"
            kind="image"
            defaultValue={campaign?.brandHeroUrl ?? ""}
            hint="Shown at the top of the RSVP page."
          />
        </div>
      </details>
      <details className="col-span-2 group" open={!!(campaign?.subjectEmail || campaign?.templateEmail || campaign?.templateSms)}>
        <summary className="cursor-pointer text-sm text-ink-500 select-none py-2">
          Email & SMS message copy
        </summary>
        <div className="mt-4 grid grid-cols-2 gap-6">
          <Field label="Email subject" className="col-span-2">
            <input
              name="subjectEmail"
              className="field"
              maxLength={300}
              defaultValue={campaign?.subjectEmail ?? ""}
              placeholder="Invitation - {{campaign}}"
            />
          </Field>
          <Field label="Email body" className="col-span-2">
            <textarea
              name="templateEmail"
              rows={6}
              className="field font-mono text-xs"
              maxLength={5000}
              defaultValue={campaign?.templateEmail ?? ""}
            />
          </Field>
          <Field label="SMS body" className="col-span-2">
            <textarea
              name="templateSms"
              rows={2}
              className="field font-mono text-xs"
              maxLength={500}
              defaultValue={campaign?.templateSms ?? ""}
            />
          </Field>
          <p className="col-span-2 text-xs text-ink-400">
            Reusable library templates can be applied above this form. What you save here is what the
            campaign will actually send.
          </p>
          <p className="col-span-2 text-xs text-ink-400">
            Tokens: <code>{"{{name}}"}</code> <code>{"{{title}}"}</code> <code>{"{{campaign}}"}</code>{" "}
            <code>{"{{venue}}"}</code> <code>{"{{eventAt}}"}</code> <code>{"{{rsvpUrl}}"}</code>{" "}
            <code>{"{{brand}}"}</code>. Wrap in{" "}
            <code>{"{{#venue}}...{{/venue}}"}</code> to hide a block when the value is empty.
          </p>
        </div>
      </details>
      {/*
        P17-D.2 - WhatsApp template config. Separate disclosure from
        the Email/SMS block above because a WhatsApp template is NOT
        a freeform body: `templateWhatsAppName` is an exact-match
        reference to a pre-approved Meta template, and
        `templateWhatsAppVariables` is a JSON array of positional
        param expressions (Meta's {{1}} / {{2}} / {{3}} model) - a
        fundamentally different shape from the inline-token
        `{{name}}` / `{{venue}}` style the email + SMS templates
        use. Rendering them together would suggest they're
        interchangeable; they're not. The D.3 PDF picker will also
        land inside this disclosure.

        Opens by default when any of the three fields are set on
        edit, matching the Branding + Templates disclosures above.
      */}
      <details
        className="col-span-2 group"
        open={
          !!(
            campaign?.templateWhatsAppName ||
            campaign?.templateWhatsAppLanguage ||
            campaign?.templateWhatsAppVariables ||
            campaign?.whatsappDocumentUploadId
          )
        }
      >
        <summary className="cursor-pointer text-sm text-ink-500 select-none py-2">
          WhatsApp message setup
        </summary>
        <WhatsAppCampaignSetup
          templateName={campaign?.templateWhatsAppName ?? null}
          templateLanguage={campaign?.templateWhatsAppLanguage ?? null}
          templateVariables={campaign?.templateWhatsAppVariables ?? null}
          whatsappDocumentUploadId={campaign?.whatsappDocumentUploadId ?? null}
          whatsappDocumentFilename={whatsappDocumentFilename ?? null}
        />
      </details>
      <div className="col-span-2 flex items-center justify-end gap-3 pt-2">
        <Link href={cancelHref} className="btn-ghost">Cancel</Link>
        <button className="btn-primary">{submitLabel}</button>
      </div>
    </form>
  );
}
