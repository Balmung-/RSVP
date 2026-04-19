import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runImport,
  type PlannerDeps,
  type PlannerInputs,
} from "../../src/lib/importPlanner";

// P7 — preview/commit parity regression guard.
//
// The planner's entire reason to exist is that `propose_import` and
// `commit_import` MUST agree on counters. GPT's course-correction
// was explicit: "if `propose_import` computes expected counters from
// `reviewIngest` while `commit_import` writes via different logic,
// you recreate the exact preview/commit trust gap we already avoided
// on `propose_send`." The planner solves that by running the same
// row-by-row loop in both modes. This test pins that invariant —
// WITHOUT it, a future edit could silently reintroduce drift between
// the preview widget a user confirms and the commit result the write
// actually produces.
//
// The tests drive the planner through an in-memory fake that mirrors
// the narrow PlannerDeps interface: existing-key lookup + createMany
// + audit insert. Preview and commit run against the SAME fake
// instance (so committed rows show up as existing on a re-preview),
// and we assert every counter on the PlannerReport matches.
//
// NOTE: CSV fixtures intentionally use email-only rows. The
// `normalizePhone` helper pulls in libphonenumber-js whose bundled
// metadata doesn't load cleanly under tsx's ESM resolution (the min
// JSON bundle is missing the `countries` shape when reached through
// the tsx harness). The parity invariant doesn't depend on whether
// a row's dedupKey comes from email+phone or email-only — the hash
// function is the same and the dedupe semantics don't branch on
// channel. If/when the tsx libphonenumber issue is fixed, adding a
// phone-bearing row to any fixture here is a one-line change.

// ---- in-memory fake deps --------------------------------------------
//
// Models just enough of Prisma to exercise the planner:
//   - Contact has a GLOBAL dedupKey set.
//   - Invitee has a (campaignId, dedupKey) composite — scoped per
//     campaign, so the same dedupKey can exist in two campaigns.
//   - EventLog captures audit rows so we can assert the commit path
//     wrote one and the preview path did not.

type InMemoryStore = {
  contactKeys: Set<string>;
  inviteeKeys: Map<string, Set<string>>; // campaignId -> Set<dedupKey>
  contactRows: number;
  inviteeRows: number;
  audits: Array<{ refType: string; refId: string | null; data: string }>;
};

function makeStore(): InMemoryStore {
  return {
    contactKeys: new Set(),
    inviteeKeys: new Map(),
    contactRows: 0,
    inviteeRows: 0,
    audits: [],
  };
}

function makeDeps(store: InMemoryStore): PlannerDeps {
  return {
    async existingContactKeys(keys) {
      const hit = new Set<string>();
      for (const k of keys) if (store.contactKeys.has(k)) hit.add(k);
      return hit;
    },
    async existingInviteeKeys(campaignId, keys) {
      const scope = store.inviteeKeys.get(campaignId);
      const hit = new Set<string>();
      if (!scope) return hit;
      for (const k of keys) if (scope.has(k)) hit.add(k);
      return hit;
    },
    async createContacts(rows) {
      for (const r of rows) store.contactKeys.add(r.dedupKey);
      store.contactRows += rows.length;
      return { count: rows.length };
    },
    async createInvitees(rows) {
      for (const r of rows) {
        let scope = store.inviteeKeys.get(r.campaignId);
        if (!scope) {
          scope = new Set();
          store.inviteeKeys.set(r.campaignId, scope);
        }
        scope.add(r.dedupKey);
      }
      store.inviteeRows += rows.length;
      return { count: rows.length };
    },
    async auditImport(args) {
      store.audits.push(args);
    },
  };
}

// CSV text helpers — keep the test bodies focused on the invariants
// being pinned, not on CSV authoring.
function csv(rows: string[][]): string {
  return rows.map((r) => r.join(",")).join("\n");
}

// ---- the parity invariant -------------------------------------------

test("parity: contacts — preview counters equal commit counters on an empty DB", async () => {
  // Mix of new rows, duplicates within the file, and invalid rows.
  // No existing-DB rows yet. Preview and commit running against the
  // same starting state must emit identical counters for every field
  // the widget reads.
  const text = csv([
    ["full_name", "email"],
    ["Alice", "alice@example.com"],
    ["Bob", "bob@example.com"],
    // within-file dup — same email as Alice
    ["Alice Copy", "alice@example.com"],
    // invalid — has name but no email (dedupKey would need one of the two)
    ["Carol", ""],
    ["Dan", "dan@example.com"],
  ]);
  const inputs: PlannerInputs = { target: "contacts", text, createdBy: null };

  const store = makeStore();
  const deps = makeDeps(store);
  const preview = await runImport(inputs, "preview", deps);

  const store2 = makeStore();
  const deps2 = makeDeps(store2);
  const commit = await runImport(inputs, "commit", deps2);

  assert.equal(preview.total, commit.total, "total parity");
  assert.equal(preview.willCreate, commit.willCreate, "willCreate parity");
  assert.equal(preview.created, commit.created, "created parity");
  assert.equal(
    preview.duplicatesWithin,
    commit.duplicatesWithin,
    "duplicatesWithin parity",
  );
  assert.equal(
    preview.duplicatesExisting,
    commit.duplicatesExisting,
    "duplicatesExisting parity",
  );
  assert.equal(preview.invalid, commit.invalid, "invalid parity");
  assert.equal(preview.capped, commit.capped, "capped parity");

  // Sanity-check the absolute numbers too, so a future refactor that
  // zeroed every counter in both paths wouldn't trivially pass.
  assert.equal(preview.total, 5);
  assert.equal(preview.invalid, 1, "Carol is invalid (no email, no phone)");
  assert.equal(preview.duplicatesWithin, 1, "Alice Copy is within-file dup");
  assert.equal(preview.willCreate, 3, "Alice, Bob, Dan");
});

test("parity: contacts — preview-then-commit-twice converges", async () => {
  // The most dangerous drift scenario: a user previews, confirms,
  // then re-previews. The second preview must report zero new rows
  // and N existing dupes — matching what a second commit would
  // return (which must be a no-op, since all rows now exist).
  const text = csv([
    ["name", "email"],
    ["Alice", "alice@example.com"],
    ["Bob", "bob@example.com"],
  ]);
  const inputs: PlannerInputs = { target: "contacts", text, createdBy: null };

  const store = makeStore();
  const deps = makeDeps(store);

  const p1 = await runImport(inputs, "preview", deps);
  const c1 = await runImport(inputs, "commit", deps);
  // Second preview after commit — rows now exist, so the planner
  // should classify them as duplicatesExisting.
  const p2 = await runImport(inputs, "preview", deps);
  const c2 = await runImport(inputs, "commit", deps);

  assert.equal(p1.willCreate, 2);
  assert.equal(c1.created, 2);
  assert.equal(p1.willCreate, c1.created, "first-round parity");

  assert.equal(p2.willCreate, 0, "re-preview sees no new rows");
  assert.equal(p2.duplicatesExisting, 2, "re-preview flags both as existing");
  assert.equal(c2.created, 0, "re-commit is a no-op");
  assert.equal(c2.duplicatesExisting, 2, "re-commit flags both as existing");

  // Cross-mode parity after a commit has landed.
  assert.equal(p2.willCreate, c2.created, "second-round willCreate==created");
  assert.equal(
    p2.duplicatesExisting,
    c2.duplicatesExisting,
    "second-round duplicatesExisting parity",
  );
});

test("parity: invitees — preview matches commit scoped to campaignId", async () => {
  // Invitee dedupe is scoped to campaignId. The same person in a
  // different campaign is a new row, not a dup. The planner's
  // `existingInviteeKeys(campaignId, keys)` contract is what keeps
  // that right.
  const text = csv([
    ["name", "email", "guests", "tier"],
    ["Alice", "alice@example.com", "2", "vip"],
    ["Bob", "bob@example.com", "0", "standard"],
  ]);
  const inputsA: PlannerInputs = {
    target: "invitees",
    text,
    campaignId: "camp_A",
  };
  const inputsB: PlannerInputs = {
    target: "invitees",
    text,
    campaignId: "camp_B",
  };

  const store = makeStore();
  const deps = makeDeps(store);

  // Commit to camp_A, THEN preview camp_B — camp_B must still see
  // both as new (different campaign scope).
  const commitA = await runImport(inputsA, "commit", deps);
  const previewB = await runImport(inputsB, "preview", deps);

  assert.equal(commitA.created, 2);
  assert.equal(previewB.willCreate, 2, "camp_B sees these as new");
  assert.equal(previewB.duplicatesExisting, 0);

  // And previewing camp_A again sees both as existing.
  const previewA2 = await runImport(inputsA, "preview", deps);
  assert.equal(previewA2.willCreate, 0);
  assert.equal(previewA2.duplicatesExisting, 2);
});

test("commit-only: preview does not write rows or audit, commit does both", async () => {
  // Preview must be side-effect-free. The whole point of the mode
  // split is that operators can see the expected counters before
  // anything touches the DB.
  const text = csv([
    ["name", "email"],
    ["Alice", "alice@example.com"],
    ["Bob", "bob@example.com"],
  ]);
  const inputs: PlannerInputs = { target: "contacts", text, createdBy: null };

  const store = makeStore();
  const deps = makeDeps(store);

  await runImport(inputs, "preview", deps);
  assert.equal(store.contactRows, 0, "preview must not insert rows");
  assert.equal(store.audits.length, 0, "preview must not write audit");

  await runImport(inputs, "commit", deps);
  assert.equal(store.contactRows, 2, "commit writes rows");
  assert.equal(store.audits.length, 1, "commit writes exactly one audit");
  assert.equal(store.audits[0]!.refType, "contact_batch");
  assert.equal(store.audits[0]!.refId, null);
});

test("commit audit: invitees target carries campaignId as refId", async () => {
  // The EventLog audit stream is what trace-back queries use to
  // attribute a commit back to its campaign. Contacts batches are
  // global (refId null); invitees batches MUST carry the campaignId.
  // The admin UI's campaign events page filters on this.
  const text = csv([
    ["name", "email"],
    ["Alice", "alice@example.com"],
  ]);
  const inputs: PlannerInputs = {
    target: "invitees",
    text,
    campaignId: "camp_xyz",
  };

  const store = makeStore();
  const deps = makeDeps(store);
  await runImport(inputs, "commit", deps);

  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0]!.refType, "campaign");
  assert.equal(store.audits[0]!.refId, "camp_xyz");
  // The audit data is the stringified PlannerReport, so it can be
  // replayed from the event log if needed.
  const parsed = JSON.parse(store.audits[0]!.data) as Record<string, unknown>;
  assert.equal(parsed.created, 1);
});

test("capped: total reports pre-cap row count; capped flag fires", async () => {
  // total MUST be the uncapped row count so the widget's "Truncated
  // to 10,000 rows of 12,345" message can display the real number.
  // Build a file > MAX_IMPORT_ROWS so the cap fires.
  const lines = [["full_name", "email"]];
  const N = 10_050;
  for (let i = 0; i < N; i += 1) {
    lines.push([`User${i}`, `user${i}@example.com`]);
  }
  const text = csv(lines);
  const inputs: PlannerInputs = { target: "contacts", text, createdBy: null };

  const store = makeStore();
  const deps = makeDeps(store);
  const preview = await runImport(inputs, "preview", deps);

  assert.equal(preview.total, N, "total reports pre-cap count");
  assert.equal(preview.capped, true, "capped flag set");
  assert.equal(
    preview.willCreate,
    10_000,
    "willCreate is capped to MAX_IMPORT_ROWS",
  );
});

test("empty after normalise: no deps calls, but report shape is still valid", async () => {
  // All-invalid file — each row survives the CSV parser (at least
  // one non-empty field) but fails normalisation. The planner
  // short-circuits before any DB call. The widget still needs a
  // valid report (all zeros + invalid count) to render the "nothing
  // to do" state.
  //
  // Notes on fixture shape:
  //  - Row A: name but no email → normaliseRow returns null
  //    (missing contact channel), counts as invalid.
  //  - Row B: email but no name → normaliseRow returns null
  //    (missing name), counts as invalid.
  //  - Both rows have at least one non-empty field so the CSV parser
  //    keeps them (it drops rows whose fields are ALL empty).
  const text = csv([
    ["name", "email"],
    ["Nameless", ""],
    ["", "bad@example.com"],
  ]);
  const inputs: PlannerInputs = { target: "contacts", text, createdBy: null };

  const store = makeStore();
  const baseDeps = makeDeps(store);

  // Track whether deps got called by wrapping them.
  let existingCalls = 0;
  let createCalls = 0;
  const wrapped: PlannerDeps = {
    ...baseDeps,
    async existingContactKeys(keys) {
      existingCalls += 1;
      return baseDeps.existingContactKeys(keys);
    },
    async createContacts(rows) {
      createCalls += 1;
      return baseDeps.createContacts(rows);
    },
  };

  const report = await runImport(inputs, "commit", wrapped);
  assert.equal(report.total, 2);
  assert.equal(report.invalid, 2);
  assert.equal(report.willCreate, 0);
  assert.equal(report.created, 0);
  assert.equal(existingCalls, 0, "no lookup when nothing survives normalise");
  assert.equal(createCalls, 0, "no createMany when fresh is empty");
  assert.equal(store.audits.length, 0, "no audit when nothing was created");
});

test("mixed-target parity: same csv, both targets, per-target parity holds", async () => {
  // A single CSV is evaluated twice — once as contacts, once as
  // invitees — and preview/commit must agree WITHIN each target.
  // This guards against a future refactor that accidentally
  // cross-references the two targets' lookup paths.
  const text = csv([
    ["name", "email"],
    ["Alice", "alice@example.com"],
    ["Bob", "bob@example.com"],
    ["Alice Dup", "alice@example.com"],
  ]);

  // Contacts target — fresh store for preview vs commit to pin
  // that the counters match on empty DB.
  {
    const preview = await runImport(
      { target: "contacts", text, createdBy: null },
      "preview",
      makeDeps(makeStore()),
    );
    const commit = await runImport(
      { target: "contacts", text, createdBy: null },
      "commit",
      makeDeps(makeStore()),
    );
    assert.equal(preview.willCreate, commit.willCreate);
    assert.equal(preview.duplicatesWithin, commit.duplicatesWithin);
    assert.equal(preview.invalid, commit.invalid);
  }

  // Invitees target — same text, fresh campaignId scope, same parity.
  {
    const invInputs: PlannerInputs = {
      target: "invitees",
      text,
      campaignId: "camp_parity",
    };
    const preview = await runImport(
      invInputs,
      "preview",
      makeDeps(makeStore()),
    );
    const commit = await runImport(invInputs, "commit", makeDeps(makeStore()));
    assert.equal(preview.willCreate, commit.willCreate);
    assert.equal(preview.duplicatesWithin, commit.duplicatesWithin);
    assert.equal(preview.invalid, commit.invalid);
  }
});
