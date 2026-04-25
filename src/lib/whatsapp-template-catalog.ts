export type ApprovedWhatsAppTemplate = {
  id: string;
  label: string;
  templateName: string;
  language: string;
  kind: "document";
  requiresDocument: boolean;
  autoVariables: ReadonlyArray<{
    label: string;
    expression: string;
  }>;
  note?: string;
};

// Provider-level enablement answers "can we send WhatsApp at all?"
// This catalog answers "which approved template can this campaign use?"
// Keeping it explicit makes campaign setup a real choice instead of
// asking operators to hand-type a Meta template key pair.
export const APPROVED_WHATSAPP_TEMPLATES: ApprovedWhatsAppTemplate[] = [
  {
    id: "invite-pdf-ar",
    label: "Invitation PDF (AR)",
    templateName: "moather2026_moather2026",
    language: "ar",
    kind: "document",
    requiresDocument: true,
    autoVariables: [],
    note: "Approved Taqnyat / Meta template for invitation PDFs.",
  },
];

export function serializeApprovedWhatsAppVariables(
  template: ApprovedWhatsAppTemplate,
): string | null {
  if (template.autoVariables.length === 0) return null;
  return JSON.stringify(template.autoVariables.map((variable) => variable.expression));
}

export function findApprovedWhatsAppTemplateById(
  id: string | null | undefined,
): ApprovedWhatsAppTemplate | null {
  if (!id) return null;
  return APPROVED_WHATSAPP_TEMPLATES.find((template) => template.id === id) ?? null;
}

export function findApprovedWhatsAppTemplateByPair(
  templateName: string | null | undefined,
  language: string | null | undefined,
): ApprovedWhatsAppTemplate | null {
  if (!templateName || !language) return null;
  return (
    APPROVED_WHATSAPP_TEMPLATES.find(
      (template) =>
        template.templateName === templateName && template.language === language,
    ) ?? null
  );
}

export function findApprovedWhatsAppTemplateByName(
  templateName: string | null | undefined,
): ApprovedWhatsAppTemplate | null {
  if (!templateName) return null;
  const matches = APPROVED_WHATSAPP_TEMPLATES.filter(
    (template) => template.templateName === templateName,
  );
  return matches.length === 1 ? matches[0] : null;
}
