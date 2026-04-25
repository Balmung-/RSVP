import {
  findApprovedWhatsAppTemplateById,
  serializeApprovedWhatsAppVariables,
} from "@/lib/whatsapp-template-catalog";

export type ParsedWhatsAppCampaignFields = {
  templateWhatsAppName: string | null;
  templateWhatsAppLanguage: string | null;
  templateWhatsAppVariables: string | null;
  whatsappDocumentUploadId: string | null;
};

const NAME_MAX = 200;
const LANGUAGE_MAX = 10;
const VARIABLES_MAX = 2000;
const UPLOAD_ID_MAX = 50;

function readField(fd: FormData, key: string): string {
  const raw = fd.get(key);
  return typeof raw === "string" ? raw.trim() : "";
}

function clipNullIfEmpty(s: string, max: number): string | null {
  const clipped = s.length > max ? s.slice(0, max) : s;
  return clipped.length === 0 ? null : clipped;
}

// Normalize the campaign-facing WhatsApp form into the four persisted
// columns the rest of the send pipeline consumes. The operator path has
// three modes:
//   - off:      save no WhatsApp config
//   - approved: choose a known approved template from the catalog
//   - custom:   fill the raw provider fields intentionally
//
// Approved templates own their own positional-variable mapping, so the
// parser serializes that internal schema and does not preserve raw JSON
// from the operator path.
export function parseWhatsAppCampaignFields(
  fd: FormData,
): ParsedWhatsAppCampaignFields {
  const mode = clipNullIfEmpty(readField(fd, "templateWhatsAppMode"), NAME_MAX) ?? "off";
  const selectedPreset = findApprovedWhatsAppTemplateById(
    mode === "approved"
      ? clipNullIfEmpty(readField(fd, "templateWhatsAppPreset"), NAME_MAX)
      : null,
  );

  const rawName =
    mode === "custom"
      ? clipNullIfEmpty(readField(fd, "templateWhatsAppName"), NAME_MAX)
      : null;
  const rawLanguage =
    mode === "custom"
      ? clipNullIfEmpty(readField(fd, "templateWhatsAppLanguage"), LANGUAGE_MAX)
      : null;
  const rawVariables =
    mode === "custom"
      ? clipNullIfEmpty(readField(fd, "templateWhatsAppVariables"), VARIABLES_MAX)
      : null;

  return {
    templateWhatsAppName: selectedPreset?.templateName ?? rawName,
    templateWhatsAppLanguage: selectedPreset?.language ?? rawLanguage,
    templateWhatsAppVariables: selectedPreset
      ? serializeApprovedWhatsAppVariables(selectedPreset)
      : rawVariables,
    whatsappDocumentUploadId: clipNullIfEmpty(
      readField(fd, "whatsappDocumentUploadId"),
      UPLOAD_ID_MAX,
    ),
  };
}
