// P17-D.1 — shared FormData → Campaign WhatsApp fields parser.
//
// Pure + synchronous + DB-free. Called by the `createCampaign` and
// `updateCampaign` server actions (in `src/app/campaigns/new/page.tsx`
// and `src/app/campaigns/[id]/edit/page.tsx`) to read the four
// WhatsApp-campaign fields off the submitted form and normalize
// them into the shape the Prisma write layer consumes:
//
//   - templateWhatsAppName      (string | null)
//   - templateWhatsAppLanguage  (string | null)
//   - templateWhatsAppVariables (string | null — stored raw JSON)
//   - whatsappDocumentUploadId  (string | null — FK, existence
//                                 checked at the server-action
//                                 level, NOT here)
//
// Why pure / sync / DB-free:
// - Keeps the parser trivially unit-testable without a Prisma
//   mock. The FK existence check lives inside the server action
//   for the same reason the propose_send / send_campaign handlers
//   do their own lookups rather than teaching `computeBlockers`
//   to hit the DB.
// - Keeps the write-time surface symmetric with how the existing
//   email / SMS template fields are parsed today (they're all
//   inline `String(fd.get(...)).trim().slice(0, N) || null` on the
//   page.tsx server actions). Extracting the WhatsApp quartet
//   into a helper is worth it because:
//     * the four fields are a coupled concept (one campaign's
//       WhatsApp-PDF config) and will likely evolve together;
//     * the `templateWhatsAppVariables` JSON discipline is subtle
//       enough that duplicating the normalization across
//       `createCampaign` + `updateCampaign` would invite drift;
//     * a `src/lib/campaign-whatsapp-form.ts` seam parallels the
//       existing `src/lib/campaign-duplicate.ts` convention for
//       campaign-shaped helpers.
//
// What this parser deliberately does NOT do:
// - No JSON validation of `templateWhatsAppVariables`. A non-null
//   value is stored verbatim; the blocker layer's
//   `template_vars_malformed` emission (see
//   `src/lib/ai/tools/send-blockers.ts:298-305`) catches
//   unparseable JSON at send time. This matches the existing
//   `templateEmail` / `templateSms` discipline: arbitrary text is
//   accepted at write time; render-time failures surface in the
//   preview / send path. Storing the raw input also lets the
//   operator see their malformed string in the edit form and fix
//   it, rather than seeing a silently-cleared field.
// - No FK existence check on `whatsappDocumentUploadId`. The
//   caller (server action) does the lookup after parsing; if the
//   id doesn't resolve, the caller writes `null` for that field.
//   Keeps the parser pure.
// - No both-or-neither enforcement for (name, language). A
//   campaign can save with only the name or only the language;
//   the `no_whatsapp_template` blocker surfaces the gap at send
//   time. Matches the existing permissive pattern for
//   templateEmail + subjectEmail.

export type ParsedWhatsAppCampaignFields = {
  templateWhatsAppName: string | null;
  templateWhatsAppLanguage: string | null;
  templateWhatsAppVariables: string | null;
  whatsappDocumentUploadId: string | null;
};

// Length caps. Justified in the `.p17d-notepad.md` design-calls
// block; in one line each here:
//
//   - NAME_MAX (200):      matches Campaign.name column discipline
//                          and stays well under Meta's template
//                          name limit.
//   - LANGUAGE_MAX (10):   BCP-47 worst-case e.g. `zh_Hant_HK`.
//                          Any sensible Meta language code is
//                          shorter.
//   - VARIABLES_MAX (2000):generous for a JSON array of ~20
//                          expression strings. A realistic pilot
//                          template has <= 5 vars and fits well
//                          under 200 chars; 2000 is headroom.
//   - UPLOAD_ID_MAX (50):  cuid is 25 chars; 50 leaves room for
//                          future id format changes (e.g. a
//                          uuidv4 with dashes is 36).
const NAME_MAX = 200;
const LANGUAGE_MAX = 10;
const VARIABLES_MAX = 2000;
const UPLOAD_ID_MAX = 50;

// Small helpers. Written inline rather than importing from another
// shared util because the existing `createCampaign` /
// `updateCampaign` handlers use the same `String(fd.get(...))
// .trim().slice(0, N) || null` pattern inline — keeping the
// readability local means the server actions read the same way
// before and after this refactor.

function readField(fd: FormData, key: string): string {
  const raw = fd.get(key);
  return typeof raw === "string" ? raw.trim() : "";
}

function clipNullIfEmpty(s: string, max: number): string | null {
  const clipped = s.length > max ? s.slice(0, max) : s;
  return clipped.length === 0 ? null : clipped;
}

// Main entry point. Reads the four WhatsApp fields from `fd` and
// returns them in the shape `prisma.campaign.create({data: ...})`
// and `.update` can spread in directly.
export function parseWhatsAppCampaignFields(
  fd: FormData,
): ParsedWhatsAppCampaignFields {
  return {
    templateWhatsAppName: clipNullIfEmpty(
      readField(fd, "templateWhatsAppName"),
      NAME_MAX,
    ),
    templateWhatsAppLanguage: clipNullIfEmpty(
      readField(fd, "templateWhatsAppLanguage"),
      LANGUAGE_MAX,
    ),
    templateWhatsAppVariables: clipNullIfEmpty(
      readField(fd, "templateWhatsAppVariables"),
      VARIABLES_MAX,
    ),
    whatsappDocumentUploadId: clipNullIfEmpty(
      readField(fd, "whatsappDocumentUploadId"),
      UPLOAD_ID_MAX,
    ),
  };
}
