// P17-D.6 — pure render-side helper that applies the FileUpload
// ownership-check result to a Campaign row before it's passed into
// the client form. Pairs with the write-path scope from P17-D.4:
//
//   - D.4 (write path): `createCampaign` / `updateCampaign` server
//     actions gate `whatsappDocumentUploadId` on `uploadedBy = me.id`
//     so an editor can only bind their OWN upload to a campaign.
//   - D.5 (read path): `EditCampaign` gates the page-render resolve
//     on `uploadedBy = me.id` and — before this slice — inlined the
//     spread-null that strips an unauthorized FK from the rendered
//     `CampaignForm`. GPT's green-light verdict called that seam out
//     as "narrow enough not to block, but if Claude extracts that
//     seam later it should get a unit pin" (Agent chat.md L16045).
//
// D.6 hoists the inline "apply ownership to render payload" logic
// into this module so:
//
//  1. the render-side null-masking and the filename-resolve are
//     unit-testable without spinning a Prisma mock — the impure
//     ownership query stays in the calling page, the helper
//     receives the already-resolved `OwnedWhatsAppUpload | null`;
//  2. a future change to the masking behaviour (e.g. adding a
//     team-shared scope, or an admin carve-out) can't silently
//     drift against the write-path scope — both halves now
//     consume a single shared seam with pinned tests.
//
// The helper is deliberately DB-free. The calling page owns the
// scope query (today: `findFirst({where: {id, uploadedBy: me.id}})`)
// and feeds the result in. Keeping the seam pure means the unit
// pins are honest: they cover the masking contract, not a Prisma
// shape the test would have to re-declare.
//
// Behavioural contract (pinned in
// `tests/unit/campaign-whatsapp-render.test.ts`):
//
//  - `ownedUpload` present → pass the campaign through unchanged,
//    surface `ownedUpload.filename` as the display filename.
//  - `ownedUpload` null → clone the campaign with
//    `whatsappDocumentUploadId` forced to `null`, surface a null
//    filename. The clone guarantees the caller's original row is
//    not mutated and that no unauthorized FK reaches the rendered
//    DOM (the `WhatsAppDocumentInput` writes the FK into a hidden
//    `<input>`, which is exactly the leak path D.5 closed).
//  - The helper does NOT differentiate "the campaign has no FK at
//    all" from "the campaign has a FK but the caller failed the
//    ownership check". Both collapse to the `ownedUpload = null`
//    branch. That's by design: the caller only runs the ownership
//    query when the FK is non-null, so `ownedUpload = null` is
//    always the "not owned or not present" aggregate — there's no
//    observable behavioural difference between the two from the
//    render's perspective.

/**
 * Shape of the server-side ownership query result. Matches the
 * `select: { id: true, filename: true }` projection used by the
 * edit page's scoped `prisma.fileUpload.findFirst(...)` call.
 */
export type OwnedWhatsAppUpload = {
  id: string;
  filename: string;
};

/**
 * Return shape of {@link resolveOwnedWhatsAppUpload}. The
 * `safeCampaign` field is the same shape as the input campaign
 * (preserved via the generic `T`), so callers can spread the
 * result into their existing render paths without casting.
 */
export type ResolvedOwnedWhatsAppUpload<T> = {
  safeCampaign: T;
  whatsappDocumentFilename: string | null;
};

/**
 * Apply the FileUpload ownership-check result to a Campaign row
 * before passing it into `CampaignForm`.
 *
 * See the module header for the full rationale and the exact
 * behavioural contract. In one sentence: if `ownedUpload` is
 * null, the returned `safeCampaign` is a shallow clone with
 * `whatsappDocumentUploadId` forced to `null`; otherwise the
 * original campaign is returned verbatim.
 */
export function resolveOwnedWhatsAppUpload<
  T extends { whatsappDocumentUploadId: string | null },
>(
  campaign: T,
  ownedUpload: OwnedWhatsAppUpload | null,
): ResolvedOwnedWhatsAppUpload<T> {
  if (ownedUpload) {
    return {
      safeCampaign: campaign,
      whatsappDocumentFilename: ownedUpload.filename,
    };
  }
  return {
    safeCampaign: { ...campaign, whatsappDocumentUploadId: null },
    whatsappDocumentFilename: null,
  };
}
