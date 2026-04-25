"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { Field } from "./Field";
import { WhatsAppDocumentInput } from "./WhatsAppDocumentInput";
import {
  APPROVED_WHATSAPP_TEMPLATES,
  findApprovedWhatsAppTemplateById,
  findApprovedWhatsAppTemplateByName,
  findApprovedWhatsAppTemplateByPair,
} from "@/lib/whatsapp-template-catalog";

type Mode = "off" | "approved" | "custom";

export function WhatsAppCampaignSetup({
  templateName,
  templateLanguage,
  templateVariables,
  whatsappDocumentUploadId,
  whatsappDocumentFilename,
}: {
  templateName?: string | null;
  templateLanguage?: string | null;
  templateVariables?: string | null;
  whatsappDocumentUploadId?: string | null;
  whatsappDocumentFilename?: string | null;
}) {
  const selectedTemplate =
    findApprovedWhatsAppTemplateByPair(templateName ?? null, templateLanguage ?? null) ??
    findApprovedWhatsAppTemplateByName(templateName ?? null);
  const defaultTemplate =
    selectedTemplate ??
    (APPROVED_WHATSAPP_TEMPLATES.length === 1 ? APPROVED_WHATSAPP_TEMPLATES[0] : null);
  const inferredMode: Mode = selectedTemplate
    ? "approved"
    : templateName || templateLanguage || templateVariables
      ? "custom"
      : defaultTemplate
        ? "approved"
        : "off";

  const [mode, setMode] = useState<Mode>(inferredMode);
  const [presetId, setPresetId] = useState<string>(defaultTemplate?.id ?? "");

  const preset = useMemo(
    () => findApprovedWhatsAppTemplateById(presetId),
    [presetId],
  );

  return (
    <div className="mt-4 grid grid-cols-2 gap-6">
      <input type="hidden" name="templateWhatsAppMode" value={mode} />

      <div className="col-span-2 rounded-xl border border-ink-100 bg-ink-0">
        <div className="grid gap-2 p-4 md:grid-cols-3">
          <ModeButton
            active={mode === "approved"}
            title="Approved template"
            body="Recommended. Choose from the templates already approved in Taqnyat / Meta."
            onClick={() => setMode("approved")}
          />
          <ModeButton
            active={mode === "custom"}
            title="Custom provider template"
            body="Advanced only. Use when you intentionally need a provider template outside the approved catalog."
            onClick={() => setMode("custom")}
          />
          <ModeButton
            active={mode === "off"}
            title="Do not use WhatsApp"
            body="Keep this campaign on email/SMS only."
            onClick={() => setMode("off")}
          />
        </div>
      </div>

      {mode === "approved" ? (
        <>
          <Field label="Approved WhatsApp template" className="col-span-2">
            <select
              name="templateWhatsAppPreset"
              className="field"
              value={presetId}
              onChange={(event) => setPresetId(event.target.value)}
            >
              <option value="">Select approved template</option>
              {APPROVED_WHATSAPP_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="col-span-2 rounded-xl border border-ink-100 bg-ink-25 p-4">
            {preset ? (
              <div className="grid gap-3 md:grid-cols-3">
                <Info label="Provider template" value={preset.templateName} />
                <Info label="Language" value={preset.language} />
                <Info
                  label="Header"
                  value={preset.requiresDocument ? "PDF document required" : "No document header"}
                />
                <div className="md:col-span-3 text-mini text-ink-500">
                  {preset.note ?? "This template is approved and safe to use for campaign sends."}
                </div>
                <div className="md:col-span-3 text-mini text-ink-500">
                  {preset.autoVariables.length === 0
                    ? "No manual variables are needed. The send path owns the template payload."
                    : `Auto-filled from campaign data: ${preset.autoVariables.map((variable) => variable.label).join(", ")}.`}
                </div>
              </div>
            ) : (
              <p className="text-body text-ink-600">
                Choose the approved WhatsApp template this campaign should use.
              </p>
            )}
          </div>
        </>
      ) : null}

      {mode === "custom" ? (
        <>
          <Field label="Template name">
            <input
              name="templateWhatsAppName"
              className="field"
              maxLength={200}
              defaultValue={templateName ?? ""}
              placeholder="provider_template_name"
            />
          </Field>
          <Field label="Language">
            <input
              name="templateWhatsAppLanguage"
              className="field"
              maxLength={10}
              defaultValue={templateLanguage ?? ""}
              placeholder="ar"
            />
          </Field>
          <Field
            label="Template variables (JSON array)"
            className="col-span-2"
            hint={'Only for custom provider templates. Example: ["{{name}}", "{{venue}}"]'}
          >
            <textarea
              name="templateWhatsAppVariables"
              rows={3}
              className="field font-mono text-xs"
              maxLength={2000}
              defaultValue={templateVariables ?? ""}
              placeholder='["{{name}}", "{{venue}}"]'
            />
          </Field>
        </>
      ) : null}

      {mode !== "off" ? (
        <div className="col-span-2">
          <WhatsAppDocumentInput
            name="whatsappDocumentUploadId"
            defaultValue={whatsappDocumentUploadId ?? ""}
            defaultFilename={whatsappDocumentFilename ?? ""}
            hint={
              mode === "approved" && preset?.requiresDocument
                ? "Required for the selected approved template."
                : "Optional unless the selected template requires a PDF header."
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function ModeButton({
  active,
  title,
  body,
  onClick,
}: {
  active: boolean;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-xl border px-4 py-3 text-start transition-colors",
        active ? "border-ink-900 bg-ink-50" : "border-ink-200 hover:border-ink-400",
      )}
    >
      <div className="text-body font-medium text-ink-900">{title}</div>
      <div className="mt-1 text-mini text-ink-500">{body}</div>
    </button>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-micro uppercase tracking-wider text-ink-400">{label}</div>
      <div className="mt-1 text-body text-ink-800">{value}</div>
    </div>
  );
}
