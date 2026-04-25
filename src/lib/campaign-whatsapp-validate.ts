import {
  findApprovedWhatsAppTemplateByPair,
  type ApprovedWhatsAppTemplate,
} from "@/lib/whatsapp-template-catalog";
import type { ParsedWhatsAppCampaignFields } from "@/lib/campaign-whatsapp-form";

export type WhatsAppCampaignValidationResult =
  | { ok: true; approvedTemplate: ApprovedWhatsAppTemplate | null }
  | { ok: false; text: string; detail?: string };

export function validateWhatsAppCampaignFields(
  fields: ParsedWhatsAppCampaignFields,
): WhatsAppCampaignValidationResult {
  const hasName = !!fields.templateWhatsAppName;
  const hasLanguage = !!fields.templateWhatsAppLanguage;
  const hasVars = !!fields.templateWhatsAppVariables;
  const hasDocument = !!fields.whatsappDocumentUploadId;

  if (!hasName && !hasLanguage && !hasVars && !hasDocument) {
    return { ok: true, approvedTemplate: null };
  }

  if (!hasName && !hasLanguage && hasDocument) {
    return {
      ok: false,
      text: "WhatsApp template is required",
      detail: "Attach a PDF only after choosing an approved WhatsApp template.",
    };
  }

  if (hasName !== hasLanguage) {
    return {
      ok: false,
      text: "WhatsApp template is incomplete",
      detail: "Template name and language must be set together.",
    };
  }

  const approvedTemplate =
    hasName && hasLanguage
      ? findApprovedWhatsAppTemplateByPair(
          fields.templateWhatsAppName,
          fields.templateWhatsAppLanguage,
        )
      : null;

  if (approvedTemplate?.requiresDocument && !hasDocument) {
    return {
      ok: false,
      text: "Invitation PDF is required",
      detail: `The approved WhatsApp template "${approvedTemplate.label}" sends with a PDF header.`,
    };
  }

  if (!approvedTemplate && hasVars && !isParsableStringArray(fields.templateWhatsAppVariables!)) {
    return {
      ok: false,
      text: "WhatsApp advanced variables are invalid",
      detail: "Custom WhatsApp variables must be a valid JSON array of strings.",
    };
  }

  return { ok: true, approvedTemplate };
}

function isParsableStringArray(s: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return false;
  }
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string");
}
