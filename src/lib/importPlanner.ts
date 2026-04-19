import { prisma } from "./db";
import {
  dedupKey,
  normalizeEmail,
  normalizePhone,
  parseContactsText,
} from "./contact";
import { newRsvpToken } from "./tokens";
import type { Prisma } from "@prisma/client";

// VIP tier enum inlined here (not imported from `./contacts`) to
// avoid a circular module graph — `contacts.ts::importContacts`
// delegates to this planner, so pulling `VIP_TIERS` back across that
// edge would create an evaluation cycle. Duplication is minor (one
// 4-entry tuple) and stays in lockstep with `contacts.ts` by type
// equivalence at the Prisma boundary.
const VIP_TIERS = ["royal", "minister", "vip", "standard"] as const;
type VipTier = (typeof VIP_TIERS)[number];

// P7 — shared full-file import planner.
//
// Lives here because `propose_import` (preview) and `commit_import`
// (destructive write) MUST produce matching counters — anything else
// recreates the preview/commit trust gap the confirmation gate
// exists to close. `reviewIngest` is the wrong seam for that: it's a
// UI preview over a SAMPLE of rows with `new / existing_match`
// statuses that use different dedupe semantics (contacts match by
// email + phone against the global Contact table; invitee imports
// actually dedupe against a per-campaign `(campaignId, dedupKey)`
// unique index). A planner that inherits `reviewIngest`'s math would
// surface numbers the commit never agrees with.
//
// So: this module runs the SAME row-by-row pipeline in both modes.
// Preview differs from commit in exactly one place — `mode !==
// "commit"` short-circuits before `createMany` + EventLog. Every
// counter the widget displays comes from the same loop that would
// actually write, so the "expected" and "result" surfaces are
// provably in sync.
//
// Inputs are discriminated by `target` so TypeScript forces the
// campaignId argument only on the invitees path (where it's required
// by the Invitee row FK) and keeps the contacts path free of
// campaign plumbing (Contact rows are global).

// ---- public types --------------------------------------------------

export const MAX_IMPORT_ROWS = 10_000;

export type ImportPlannerMode = "preview" | "commit";

export type ContactsPlannerInputs = {
  target: "contacts";
  text: string;
  createdBy?: string | null;
};

export type InviteesPlannerInputs = {
  target: "invitees";
  text: string;
  campaignId: string;
};

export type PlannerInputs = ContactsPlannerInputs | InviteesPlannerInputs;

// Counters returned by the planner. Single shape for both modes so
// the caller's widget mapping (`expected` in preview, `result` in
// commit) is a straight field projection — not a branch on mode.
//
// Field semantics:
//   total              — rows returned by `parseContactsText` (BEFORE
//                        the MAX_IMPORT_ROWS cap; `capped` reports
//                        whether that cap fired).
//   willCreate         — rows predicted to insert (preview) / actually
//                        attempted to insert (commit). Both pass
//                        through the same normalize+dedupe+DB-lookup
//                        filter so preview.willCreate ===
//                        commit.willCreate when run on the same state.
//   created            — rows ACTUALLY created. In preview this equals
//                        willCreate (prediction); in commit it equals
//                        `createMany.count` (could diverge from
//                        willCreate only on a race or driver-level
//                        skip, which is vanishingly rare for our
//                        dedupKey shape).
//   duplicatesWithin   — rows dropped because their dedupKey already
//                        appeared earlier in the same file.
//   duplicatesExisting — rows dropped because their dedupKey already
//                        exists in the target table (Contact for
//                        contacts target; Invitee-in-campaign for
//                        invitees target).
//   invalid            — rows dropped for missing name or missing
//                        email+phone.
//   capped             — true iff total > MAX_IMPORT_ROWS.
export type PlannerReport = {
  total: number;
  willCreate: number;
  created: number;
  duplicatesWithin: number;
  duplicatesExisting: number;
  invalid: number;
  capped: boolean;
};

// ---- injectable deps ----------------------------------------------
//
// The planner's DB touchpoints are extracted behind a port so the
// parity test can drive preview + commit against the SAME in-memory
// store and assert counter equivalence without booting Postgres.
// Keeping the interface minimal — just the five calls the planner
// actually makes — means the fake has nowhere to hide divergent
// logic that would make the parity proof hollow.
//
// Default implementation closes over the real prisma singleton; every
// production caller (importContacts, importInvitees, the upcoming
// propose_import / commit_import tools) should pass no deps and let
// the default bind.
export type PlannerDeps = {
  existingContactKeys(keys: string[]): Promise<Set<string>>;
  existingInviteeKeys(campaignId: string, keys: string[]): Promise<Set<string>>;
  createContacts(rows: Prisma.ContactCreateManyInput[]): Promise<{ count: number }>;
  createInvitees(rows: Prisma.InviteeCreateManyInput[]): Promise<{ count: number }>;
  auditImport(args: {
    refType: "contact_batch" | "campaign";
    refId: string | null;
    data: string;
  }): Promise<void>;
};

function defaultDeps(): PlannerDeps {
  return {
    async existingContactKeys(keys) {
      const rows = await prisma.contact.findMany({
        where: { dedupKey: { in: keys } },
        select: { dedupKey: true },
      });
      return new Set(rows.map((r) => r.dedupKey));
    },
    async existingInviteeKeys(campaignId, keys) {
      const rows = await prisma.invitee.findMany({
        where: { campaignId, dedupKey: { in: keys } },
        select: { dedupKey: true },
      });
      return new Set(rows.map((r) => r.dedupKey));
    },
    async createContacts(rows) {
      return prisma.contact.createMany({ data: rows });
    },
    async createInvitees(rows) {
      return prisma.invitee.createMany({ data: rows });
    },
    async auditImport({ refType, refId, data }) {
      await prisma.eventLog.create({
        data: { kind: "import.completed", refType, refId, data },
      });
    },
  };
}

// ---- shared row-normaliser -----------------------------------------
//
// Both the contacts and invitees pipelines feed rows through the
// exact same validation + dedupe key, so the only place they differ
// is the final `CreateManyInput` shape. Extracting this step means a
// future field tweak (say, stricter email normalisation) lands on
// both paths at once.

type NormalisedRow = {
  fullName: string;
  email: string | null;
  phoneE164: string | null;
  title: string | null;
  organization: string | null;
  preferredLocale: "en" | "ar" | null;
  tags: string | null;
  notes: string | null;
  dedupKey: string;
  // Raw fields only the invitee path needs.
  rawLocale: string;
  rawGuests: string;
  rawTier: string;
};

type ParsedRow = Record<string, string>;

// Normalise one parsed row into the canonical shape. Returns null if
// the row should be counted as `invalid` (missing name, or missing
// both email and phone).
function normaliseRow(r: ParsedRow): NormalisedRow | null {
  const fullName = (r.full_name || r.name || "").trim().slice(0, 200);
  if (!fullName) return null;
  const email = normalizeEmail(r.email);
  const phoneE164 = normalizePhone(r.phone || r.mobile || "", "SA");
  if (!email && !phoneE164) return null;
  const rawLocale = (r.locale ?? "").trim().toLowerCase();
  const preferredLocale =
    rawLocale === "ar" ? "ar" : rawLocale === "en" ? "en" : null;
  return {
    fullName,
    email,
    phoneE164,
    title: (r.title || "").trim().slice(0, 100) || null,
    organization: (r.organization || r.org || "").trim().slice(0, 200) || null,
    preferredLocale,
    tags: (r.tags || "").trim().slice(0, 500) || null,
    notes: (r.notes || "").trim().slice(0, 2000) || null,
    dedupKey: dedupKey(email, phoneE164),
    rawLocale,
    rawGuests: (r.guests ?? "").trim(),
    rawTier: (r.vip_tier || r.tier || "").trim().toLowerCase(),
  };
}

function clampInt(s: string, min: number, max: number, def: number): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function resolveTier(raw: string): VipTier {
  return (VIP_TIERS as readonly string[]).includes(raw)
    ? (raw as VipTier)
    : "standard";
}

// ---- main planner --------------------------------------------------

export async function runImport(
  inputs: PlannerInputs,
  mode: ImportPlannerMode,
  deps: PlannerDeps = defaultDeps(),
): Promise<PlannerReport> {
  const rowsAll = parseContactsText(inputs.text) as ParsedRow[];
  const capped = rowsAll.length > MAX_IMPORT_ROWS;
  const rows = capped ? rowsAll.slice(0, MAX_IMPORT_ROWS) : rowsAll;

  const report: PlannerReport = {
    total: rowsAll.length,
    willCreate: 0,
    created: 0,
    duplicatesWithin: 0,
    duplicatesExisting: 0,
    invalid: 0,
    capped,
  };

  // Pass 1 — normalise + within-file dedupe.
  const seen = new Set<string>();
  const normalised: NormalisedRow[] = [];
  for (const r of rows) {
    const n = normaliseRow(r);
    if (!n) {
      report.invalid += 1;
      continue;
    }
    if (seen.has(n.dedupKey)) {
      report.duplicatesWithin += 1;
      continue;
    }
    seen.add(n.dedupKey);
    normalised.push(n);
  }

  if (normalised.length === 0) {
    return report;
  }

  // Pass 2 — existing-row lookup, scoped to the target's dedupe
  // boundary. Contact.dedupKey is GLOBALLY unique; Invitee.dedupKey
  // is scoped `@@unique([campaignId, dedupKey])`.
  const keys = normalised.map((n) => n.dedupKey);
  const existingKeys =
    inputs.target === "contacts"
      ? await deps.existingContactKeys(keys)
      : await deps.existingInviteeKeys(inputs.campaignId, keys);

  const fresh = normalised.filter((n) => !existingKeys.has(n.dedupKey));
  report.duplicatesExisting = normalised.length - fresh.length;
  report.willCreate = fresh.length;

  // Preview path stops here — same counters, no DB write, no audit.
  // `created` echoes `willCreate` so a widget that reads only
  // `created` still lines up with the projected number.
  if (mode !== "commit") {
    report.created = fresh.length;
    return report;
  }

  // Commit path — build the target-specific createMany payload.
  if (fresh.length > 0) {
    if (inputs.target === "contacts") {
      const batch: Prisma.ContactCreateManyInput[] = fresh.map((n) => ({
        fullName: n.fullName,
        title: n.title,
        organization: n.organization,
        email: n.email,
        phoneE164: n.phoneE164,
        preferredLocale: n.preferredLocale,
        vipTier: resolveTier(n.rawTier),
        tags: n.tags,
        notes: n.notes,
        dedupKey: n.dedupKey,
        createdBy: inputs.createdBy ?? null,
      }));
      const res = await deps.createContacts(batch);
      report.created = res.count;
    } else {
      const batch: Prisma.InviteeCreateManyInput[] = fresh.map((n) => ({
        campaignId: inputs.campaignId,
        fullName: n.fullName,
        title: n.title,
        organization: n.organization,
        email: n.email,
        phoneE164: n.phoneE164,
        locale: n.rawLocale.slice(0, 5) || null,
        tags: n.tags,
        notes: n.notes,
        guestsAllowed: clampInt(n.rawGuests, 0, 20, 0),
        dedupKey: n.dedupKey,
        rsvpToken: newRsvpToken(),
      }));
      const res = await deps.createInvitees(batch);
      report.created = res.count;
    }
  }

  // EventLog audit on commit only. refType/refId matches the
  // pre-existing wrapper functions so the audit stream's
  // `kind: "import.completed"` rows keep the same trace-back shape
  // whether the import came from the admin UI or the chat flow.
  await deps.auditImport({
    refType: inputs.target === "contacts" ? "contact_batch" : "campaign",
    refId: inputs.target === "contacts" ? null : inputs.campaignId,
    data: JSON.stringify(report),
  });

  return report;
}
