export type ApprovedWhatsAppTemplate = {
  id: string;
  label: string;
  templateName: string;
  language: string;
  kind: "document";
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
    note: "Approved Taqnyat / Meta template for invitation PDFs.",
  },
];

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
