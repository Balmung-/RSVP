import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveOwnedWhatsAppUpload,
  type OwnedWhatsAppUpload,
} from "../../src/lib/campaign-whatsapp-render";

// P17-D.6 — render-side ownership masking pins.
//
// The helper is a thin pure function, but it's the seam that
// guarantees the `WhatsAppDocumentInput` hidden `<input>` can never
// receive a FileUpload id the current viewer doesn't own — i.e. it
// closes the read/leak path GPT flagged on `3e5a9b2`. The tests
// below lock the two-branch contract in place so a later refactor
// (or a widening to a team-shared scope) can't silently degrade the
// null-masking behaviour:
//
//  - owned branch  → safeCampaign is the caller's original row
//                    (identity preserved), filename surfaces;
//  - unowned branch → safeCampaign is a CLONE with the FK forced to
//                    null, filename is null, the caller's original
//                    row is not mutated.
//
// The helper is deliberately DB-free; the caller (today:
// `EditCampaign` in `src/app/campaigns/[id]/edit/page.tsx`) owns
// the Prisma `findFirst({where: {id, uploadedBy: me.id}})` lookup
// and feeds the result in. That boundary is why these pins live
// on pure shapes rather than requiring a Prisma mock.

// A minimal Campaign-shaped fixture. The helper is generic on
// `T extends { whatsappDocumentUploadId: string | null }`, so the
// extra fields are here to pin that unrelated properties pass
// through unchanged in both branches — i.e. the spread does not
// drop anything.
type CampaignFixture = {
  id: string;
  name: string;
  locale: "en" | "ar";
  whatsappDocumentUploadId: string | null;
  templateWhatsAppName: string | null;
  brandColor: string | null;
};

function fixture(overrides: Partial<CampaignFixture> = {}): CampaignFixture {
  return {
    id: "camp_fixture",
    name: "Fixture",
    locale: "en",
    whatsappDocumentUploadId: null,
    templateWhatsAppName: null,
    brandColor: null,
    ...overrides,
  };
}

test("resolveOwnedWhatsAppUpload: owned upload passes the campaign through unchanged", () => {
  const campaign = fixture({
    whatsappDocumentUploadId: "upload_abc",
    templateWhatsAppName: "moather2026_moather2026",
  });
  const owned: OwnedWhatsAppUpload = { id: "upload_abc", filename: "invite.pdf" };

  const result = resolveOwnedWhatsAppUpload(campaign, owned);

  assert.equal(result.whatsappDocumentFilename, "invite.pdf");
  // Identity pin: in the owned branch the caller's own object is
  // returned verbatim so there's no wasted clone. If this ever
  // flips to a clone-always implementation, the pin forces a
  // conscious decision (and the edit-page's `safeCampaign` pass
  // into `CampaignForm` stays semantically the same either way).
  assert.equal(result.safeCampaign, campaign);
  assert.equal(result.safeCampaign.whatsappDocumentUploadId, "upload_abc");
});

test("resolveOwnedWhatsAppUpload: unowned (null) nulls the FK on a clone and surfaces a null filename", () => {
  const campaign = fixture({
    whatsappDocumentUploadId: "upload_foreign",
    templateWhatsAppName: "moather2026_moather2026",
    brandColor: "#0a6e3d",
  });

  const result = resolveOwnedWhatsAppUpload(campaign, null);

  assert.equal(result.whatsappDocumentFilename, null);
  assert.equal(result.safeCampaign.whatsappDocumentUploadId, null);
  // Unrelated fields must pass through untouched — this is the
  // "spread doesn't drop anything" pin. If the spread logic ever
  // narrows to a hand-picked subset, these assertions fail and
  // force the widening decision to be explicit.
  assert.equal(result.safeCampaign.id, "camp_fixture");
  assert.equal(result.safeCampaign.name, "Fixture");
  assert.equal(result.safeCampaign.locale, "en");
  assert.equal(result.safeCampaign.templateWhatsAppName, "moather2026_moather2026");
  assert.equal(result.safeCampaign.brandColor, "#0a6e3d");
});

test("resolveOwnedWhatsAppUpload: does not mutate the caller's original campaign", () => {
  // The edit page reuses the fetched campaign row elsewhere on the
  // page (e.g. the delete-form label, the breadcrumb name). If the
  // helper mutated `campaign.whatsappDocumentUploadId` in place,
  // those adjacent reads would see the masked value. Pin the
  // no-mutation contract so that downstream readers stay honest.
  const campaign = fixture({ whatsappDocumentUploadId: "upload_foreign" });

  resolveOwnedWhatsAppUpload(campaign, null);

  assert.equal(campaign.whatsappDocumentUploadId, "upload_foreign");
});

test("resolveOwnedWhatsAppUpload: FK already null on campaign + null ownedUpload collapses cleanly", () => {
  // This is the "campaign has no PDF and no ownership check needed"
  // path. The caller short-circuits and passes `null` without
  // running the Prisma lookup; the helper must still return a
  // safeCampaign with `whatsappDocumentUploadId = null` and a null
  // filename. Pins that the two "null" sources (no FK at all vs.
  // FK present but unowned) collapse to the same observable shape.
  const campaign = fixture({ whatsappDocumentUploadId: null });

  const result = resolveOwnedWhatsAppUpload(campaign, null);

  assert.equal(result.safeCampaign.whatsappDocumentUploadId, null);
  assert.equal(result.whatsappDocumentFilename, null);
});

test("resolveOwnedWhatsAppUpload: owned upload with empty-string filename preserves the empty string", () => {
  // `FileUpload.filename` is a non-null `String` in the Prisma
  // schema, but an empty string is still a valid value. The
  // helper uses a nullish-coalesce (`?? null`) so an empty
  // filename passes through as "", not null. Pinning this here
  // so a later refactor to `|| null` (truthiness-coalesce) would
  // fail loudly — that flip would hide a genuine empty-filename
  // upload behind the same null signal we use for "no owned
  // upload", and the WhatsAppDocumentInput's "Replace PDF"
  // affordance would render as if no PDF were attached.
  const campaign = fixture({ whatsappDocumentUploadId: "upload_empty" });
  const owned: OwnedWhatsAppUpload = { id: "upload_empty", filename: "" };

  const result = resolveOwnedWhatsAppUpload(campaign, owned);

  assert.equal(result.whatsappDocumentFilename, "");
  assert.equal(result.safeCampaign.whatsappDocumentUploadId, "upload_empty");
});

test("resolveOwnedWhatsAppUpload: return shape has exactly the two documented fields", () => {
  // Shape pin so the edit page's destructuring
  //   const { safeCampaign, whatsappDocumentFilename } = resolveOwnedWhatsAppUpload(c, owned);
  // stays stable. Adding a new field quietly (e.g. a boolean
  // `isOwned` signal) would work at runtime but silently expand
  // the helper's contract; the pin forces such a widening to
  // update this test first.
  const campaign = fixture({ whatsappDocumentUploadId: "upload_abc" });
  const owned: OwnedWhatsAppUpload = { id: "upload_abc", filename: "x.pdf" };

  const result = resolveOwnedWhatsAppUpload(campaign, owned);

  assert.deepEqual(Object.keys(result).sort(), [
    "safeCampaign",
    "whatsappDocumentFilename",
  ]);
});
