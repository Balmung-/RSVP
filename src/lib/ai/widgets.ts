// Workspace widget helpers. Thin functional API over the ChatWidget
// table — validated at every boundary, Prisma injected so unit tests
// don't need a real DB.
//
// Callers:
//   - `src/app/api/chat/route.ts` emits workspace_snapshot on session
//     open (uses `listWidgets`), and widget_upsert / widget_remove
//     as tools produce side-effects (uses `upsertWidget` /
//     `removeWidget` / `focusWidget`).
//   - Future tool handlers will call `upsertWidget` directly instead
//     of / in addition to emitting a directive. Until W3 lands they
//     do not — the directive path stays the current UI contract.
//
// Why dep-injected prisma (not a `import { prisma }` at the top):
//   - The tests for this module run under plain tsx + node:test with
//     no DB. A `PrismaLike` interface with the four methods the
//     helpers actually call is enough of a seam to stub in-memory
//     without pulling @prisma/client.
//   - Real production code wires `prisma.chatWidget` in at the call
//     site, same pattern the OAuth handlers use (see
//     `src/app/api/oauth/google/start/handler.ts`).
//
// Validate on BOTH write and read:
//   - Write: `validateWidget(input)` rejects malformed envelopes
//     and prop shapes before the row hits the DB.
//   - Read: `validateWidgetProps(kind, parsedProps)` drops drifted
//     rows so a stale schema can't reach the renderer. "Fail closed
//     on read" matches the directive validator's trust model.

import {
  MAX_PROPS_JSON_BYTES,
  validateWidget,
  validateWidgetProps,
  type WidgetKind,
  type WidgetSlot,
} from "./widget-validate";
import { SLOT_COMPOSITION } from "./slotPolicy";

// ---- dep-injection surface ----

// The four Prisma methods this module actually touches. Mirrors
// `prisma.chatWidget.{findMany,upsert,deleteMany,findUnique}` from
// the generated client, but typed narrowly so tests can stub with a
// plain object.
export type WidgetRow = {
  id: string;
  sessionId: string;
  widgetKey: string;
  kind: string;
  slot: string;
  props: string;
  order: number;
  sourceMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PrismaLike = {
  chatWidget: {
    findMany(args: {
      where: { sessionId: string };
      orderBy: Array<Record<string, "asc" | "desc">>;
    }): Promise<WidgetRow[]>;
    upsert(args: {
      where: { sessionId_widgetKey: { sessionId: string; widgetKey: string } };
      create: {
        sessionId: string;
        widgetKey: string;
        kind: string;
        slot: string;
        props: string;
        order: number;
        sourceMessageId: string | null;
      };
      update: {
        kind: string;
        slot: string;
        props: string;
        order: number;
        sourceMessageId: string | null;
      };
    }): Promise<WidgetRow>;
    deleteMany(args: {
      where: { sessionId: string; widgetKey: string };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { sessionId_widgetKey: { sessionId: string; widgetKey: string } };
    }): Promise<WidgetRow | null>;
  };
};

// ---- public API shapes ----

// What listWidgets / upsertWidget return to callers. `props` is the
// re-parsed object (not the stored string) so SSE emitters and the
// React client can consume it without a second JSON.parse.
export type Widget = {
  widgetKey: string;
  kind: WidgetKind;
  slot: WidgetSlot;
  props: Record<string, unknown>;
  order: number;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

// Input accepted by `upsertWidget`. The caller always owns
// `sessionId` (it comes from the authenticated chat session, not
// the tool / model). Everything under `input` runs through
// `validateWidget` before the write.
export type UpsertWidgetInput = {
  sessionId: string;
  widgetKey: string;
  kind: string;
  slot: string;
  props: Record<string, unknown>;
  order?: number;
  sourceMessageId?: string | null;
};

// ---- helpers ----

// P13-E read-compat — zero-fill the per-channel 24h counters on a
// `workspace_rollup` row that pre-dates the P13-E widening. Before
// P13-E the rollup carried only `invitations.sent_24h`; the compute
// helper now writes three additional per-channel counters
// (`sent_email_24h` / `sent_sms_24h` / `sent_whatsapp_24h`) and the
// validator rejects blobs that lack them. That strict gate is the
// right forward-direction drift guard between compute and renderer
// within a single version, but it WOULD strand old persisted rows:
// a session reopened for read-only work with no subsequent write
// would never run `refreshWorkspaceSummary`, so its pre-P13-E row
// would fail revalidation and the summary widget would silently
// disappear for the remainder of the session.
//
// Scope: narrow to `workspace_rollup` and to the three exact fields
// the widening introduced. The aggregate `sent_24h` stays strict —
// if that's missing, the row is genuinely malformed, not
// cross-version.
//
// Lifecycle: on the next write-path event (any successful
// `draft_campaign` in the chat route or any successful confirm in
// the confirm route) the refresh helper rewrites the row with real
// per-channel counts, so this compat path becomes a no-op in
// practice after a single mutation. It can be removed once ops
// confirm all persisted rollup rows have the new shape (one full
// refresh cycle across all sessions).
//
// Why zero-fill rather than eager-refresh on hydrate: an eager
// refresh would require threading `campaignScope` / `ctx` through
// `rowToWidget`, which is a layering violation — `widgets.ts` is
// scope-agnostic by design. Zero-fill keeps this module pure; the
// worst-case UX is that a read-only session briefly renders the
// rollup with `(0e · 0s · 0w)` until the next mutation, which is
// visibly better than the alternative (widget disappears).
function normalizePreP13ERollup(
  kind: string,
  parsed: unknown,
): unknown {
  if (kind !== "workspace_rollup") return parsed;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }
  const props = parsed as Record<string, unknown>;
  const inv = props.invitations;
  if (inv === null || typeof inv !== "object" || Array.isArray(inv)) {
    return parsed;
  }
  const invObj = inv as Record<string, unknown>;
  // Only zero-fill when at least one per-channel field is missing;
  // when all four are present we leave the blob exactly as-is so a
  // post-P13-E row round-trips without mutation.
  if (
    "sent_email_24h" in invObj &&
    "sent_sms_24h" in invObj &&
    "sent_whatsapp_24h" in invObj
  ) {
    return parsed;
  }
  return {
    ...props,
    invitations: {
      ...invObj,
      sent_email_24h:
        typeof invObj.sent_email_24h === "number" ? invObj.sent_email_24h : 0,
      sent_sms_24h:
        typeof invObj.sent_sms_24h === "number" ? invObj.sent_sms_24h : 0,
      sent_whatsapp_24h:
        typeof invObj.sent_whatsapp_24h === "number"
          ? invObj.sent_whatsapp_24h
          : 0,
    },
  };
}

// Parse a DB row into a `Widget`, or null if the stored blob has
// drifted from the validator-approved shape. Silent drop (vs throw)
// so a single bad row doesn't blank an entire session's dashboard —
// the read path logs the drop so it's recoverable without taking
// users hostage. Callers decide whether to skip or surface.
export function rowToWidget(row: WidgetRow): Widget | null {
  let parsedProps: unknown;
  try {
    parsedProps = JSON.parse(row.props);
  } catch {
    return null;
  }
  // Normalize known cross-version shapes before strict validation.
  // Today this only covers the P13-E rollup widening (see
  // `normalizePreP13ERollup`); other widget kinds pass through
  // unchanged. The validator itself stays strict so forward drift
  // between compute + renderer within a single version still fails
  // closed.
  parsedProps = normalizePreP13ERollup(row.kind, parsedProps);
  if (!validateWidgetProps(row.kind, parsedProps)) return null;
  // `slot` is a stored string; revalidate against the closed set so
  // the client never sees an unknown slot value.
  if (
    row.slot !== "summary" &&
    row.slot !== "primary" &&
    row.slot !== "secondary" &&
    row.slot !== "action"
  ) {
    return null;
  }
  return {
    widgetKey: row.widgetKey,
    kind: row.kind as WidgetKind,
    slot: row.slot as WidgetSlot,
    props: parsedProps,
    order: row.order,
    sourceMessageId: row.sourceMessageId,
    // Dates serialise to ISO strings so they transport cleanly over
    // SSE without Date-vs-string client branches.
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---- public helpers ----

// Ordered list of all widgets for a session. Ordering matters for
// the dashboard render path: slot first (so the client can group
// without a second pass), then `order` within a slot (stable across
// reloads), then updatedAt as a tiebreaker for inserts that didn't
// specify an order. Drifted rows are silently skipped (see
// `rowToWidget`); the caller can inspect `skipped` if it needs to
// surface "we dropped N broken widgets" in a future UI.
export async function listWidgets(
  deps: { prismaLike: PrismaLike },
  sessionId: string,
): Promise<{ widgets: Widget[]; skipped: number }> {
  const rows = await deps.prismaLike.chatWidget.findMany({
    where: { sessionId },
    orderBy: [{ slot: "asc" }, { order: "asc" }, { updatedAt: "asc" }],
  });
  const widgets: Widget[] = [];
  let skipped = 0;
  for (const row of rows) {
    const w = rowToWidget(row);
    if (w === null) {
      skipped += 1;
      continue;
    }
    widgets.push(w);
  }
  return { widgets, skipped };
}

// Process-local mutex, keyed per `(sessionId, slot)`. Singleton-slot
// writes (summary / primary / secondary) serialize through here so
// the `upsert -> findMany-siblings -> deleteMany` sequence cannot
// interleave with another writer's sequence inside the same Node
// process. Coexist-per-key slots (action) bypass this lock entirely.
//
// Why process-local is the right shape:
//   - Singleton-slot widgets today are only emitted from tools
//     running inside the SSE chat stream, which is pinned to one
//     Node instance for the lifetime of a given chat session.
//   - The one other widget-write path is the confirm-route POST
//     (`/api/chat/confirm/[messageId]`), which only touches action-
//     slot widgets (coexist-per-key) and therefore never enters
//     this code path.
//   - `refreshWorkspaceSummary` writes the `workspace_rollup` widget
//     under a single stable widgetKey, so two concurrent rollup
//     refreshes take the UPDATE-in-place branch and touch no sibling
//     eviction.
// Multi-instance races across pods are therefore architecturally
// impossible for every current singleton-slot producer. If a new
// producer is ever added that can race across instances, this mutex
// would need to be replaced by a DB advisory lock or SERIALIZABLE
// transaction — the call sites of `upsertWidget` would not change.
//
// Why this mutex is the sole race guard (GPT audits 2026-04-20):
// The first audit caught that the original `upsert-then-evict`
// ordering, without serialization, could cross-delete under two
// concurrent writes and leave the singleton slot empty. The fix was
// to serialize the sequence here. An intermediate revision (55d4ee8)
// tried to ALSO reorder to `evict-then-upsert` as defence-in-depth
// for a hypothetical future mutex-less caller, but the second audit
// caught that reorder: if the upsert throws after the delete lands,
// the slot is left empty — a new zero-occupant failure mode in
// exchange for a race that this mutex already closes. The correct
// shape is: keep this mutex as the sole race guard, keep the
// `upsert-then-evict` ordering so a throwing upsert never collapses
// a prior occupant. Covered by
// `tests/unit/composition-concurrency.test.ts`.
const slotLocks = new Map<string, Promise<void>>();

async function withSlotLock<T>(
  sessionId: string,
  slot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${sessionId}:${slot}`;
  // FIFO queue via promise chain: each waiter awaits the current
  // holder, then installs its own holder. The while-loop re-checks
  // rather than awaiting a captured promise because multiple waiters
  // can unblock on the same released promise, and only the first to
  // win the `set` should proceed; subsequent waiters loop back and
  // wait on the new holder.
  while (slotLocks.has(key)) {
    await slotLocks.get(key);
  }
  let release!: () => void;
  const holder = new Promise<void>((resolve) => {
    release = resolve;
  });
  slotLocks.set(key, holder);
  try {
    return await fn();
  } finally {
    slotLocks.delete(key);
    release();
  }
}

// Insert or update a widget identified by (sessionId, widgetKey).
// Returns the persisted `Widget` (re-parsed, same shape listWidgets
// emits) on success, or null if validation fails — callers should
// treat null as "don't emit an SSE event, don't claim the write
// happened".
//
// The call is a single Prisma upsert — atomic insert-or-update.
// That matches GPT's W1 contract: "a second write to the same key
// UPDATES in place; never appends a duplicate row."
//
// P8 — singleton-per-slot eviction. When the new widget lands in a
// slot whose `SLOT_COMPOSITION` is `singleton-per-slot`
// (summary/primary/secondary), any OTHER widgets already in the
// same slot for the same session are removed so only one occupant
// remains. Same-widgetKey re-writes are an UPDATE in place and
// don't trigger eviction on themselves.
//
// Ordering: for singleton slots we run the upsert FIRST and then
// evict siblings, the whole pair serialized under `withSlotLock` so
// two concurrent writers cannot interleave. The upsert-first order
// is throw-safe: if the upsert rejects, the eviction loop never
// runs and a prior occupant of the slot remains intact. Reversing
// this (evict-first) would collapse the prior occupant on an upsert
// throw, which is strictly worse than the concurrent-write race the
// mutex already closes. Coexist-per-key slots (today: `action`)
// skip the mutex and the eviction entirely — confirm cards stack,
// they don't replace each other.
//
// Callers that need the evicted widgetKeys (e.g. the
// `WorkspaceEmitter`, which must emit a `widget_remove` SSE frame
// per evicted row so the client reducer drops them) pass an
// `onEvict` callback; other callers omit it and the evictions
// happen silently — still correct at the DB layer.
export async function upsertWidget(
  deps: {
    prismaLike: PrismaLike;
    // Fires once per successfully evicted sibling. Invoked after
    // the delete lands in the DB so the caller can emit a
    // `widget_remove` SSE with confidence the row is gone.
    onEvict?: (widgetKey: string) => void;
  },
  input: UpsertWidgetInput,
): Promise<Widget | null> {
  const validated = validateWidget({
    widgetKey: input.widgetKey,
    kind: input.kind,
    slot: input.slot,
    props: input.props,
    order: input.order,
    sourceMessageId: input.sourceMessageId,
  });
  if (!validated) return null;

  // Guard on sessionId separately — it's NOT part of the validated
  // payload (it comes from auth, not the tool), but it IS required
  // and must be a non-empty string so the unique lookup doesn't
  // land on a composite key with an empty sessionId and silently
  // succeed somewhere it shouldn't.
  if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
    return null;
  }

  // Serialise exactly once for the write. `validateWidget` already
  // confirmed `JSON.stringify(props)` succeeds and fits under
  // MAX_PROPS_JSON_BYTES, so this can't throw here.
  const propsJson = JSON.stringify(validated.props);
  // Defence-in-depth: the size cap is also enforced inside
  // validateWidget, but recomputing here covers the unlikely case of
  // a future validator skipping the stringify step. Cheap belt +
  // suspenders.
  if (Buffer.byteLength(propsJson, "utf8") > MAX_PROPS_JSON_BYTES) {
    return null;
  }

  const order = validated.order ?? 0;
  const sourceMessageId =
    validated.sourceMessageId === undefined ? null : validated.sourceMessageId;

  const isSingleton =
    SLOT_COMPOSITION[validated.slot] === "singleton-per-slot";

  // The DB-side work, factored out so the singleton branch can wrap
  // it in the per-slot mutex and the coexist branch can skip the
  // mutex entirely. Finding the siblings: we ask the DB for every
  // widget in the session and filter by slot in memory. A session
  // typically has a single-digit number of widgets, so the scan is
  // cheap and avoids expanding the narrow `PrismaLike` surface with
  // a new composite `where` shape (all tests would need to teach
  // their stub about the new predicate).
  const doWrite = async (): Promise<WidgetRow> => {
    // Upsert FIRST, then evict siblings. This ordering is throw-safe
    // by design: if the upsert rejects (validator already ran, but
    // the DB layer can still fail — connection drop, constraint, etc)
    // the eviction loop never runs and any prior occupant of the
    // slot remains intact. Reversing the order (evict-first) would
    // leave the slot empty on an upsert throw, which is strictly
    // worse than the race the mutex already closes. Concurrent-write
    // races are handled upstream by `withSlotLock`, not by this
    // ordering — see the `slotLocks` docstring.
    const row = await deps.prismaLike.chatWidget.upsert({
      where: {
        sessionId_widgetKey: {
          sessionId: input.sessionId,
          widgetKey: validated.widgetKey,
        },
      },
      create: {
        sessionId: input.sessionId,
        widgetKey: validated.widgetKey,
        kind: validated.kind,
        slot: validated.slot,
        props: propsJson,
        order,
        sourceMessageId,
      },
      update: {
        // Update DOES NOT touch widgetKey or sessionId — those are
        // the stable identity. Under P8's kind-slot policy the
        // `kind` can no longer silently migrate to an arbitrary
        // replacement kind+slot pair (the validator rejects
        // mismatches), but the shape stays write-through so a
        // future kind-swap within the same slot (e.g. a tool
        // rewriting `campaign_list` props against the same
        // widgetKey) still works.
        kind: validated.kind,
        slot: validated.slot,
        props: propsJson,
        order,
        sourceMessageId,
      },
    });
    if (isSingleton) {
      // Finding the siblings: we ask the DB for every widget in the
      // session and filter by slot in memory. A session typically has
      // a single-digit number of widgets, so the scan is cheap and
      // avoids expanding the narrow `PrismaLike` surface with a new
      // composite `where` shape (all tests would need to teach their
      // stub about the new predicate). The just-upserted row is
      // skipped by the `widgetKey === validated.widgetKey` filter so
      // we never evict our own write.
      const existing = await deps.prismaLike.chatWidget.findMany({
        where: { sessionId: input.sessionId },
        orderBy: [{ slot: "asc" }, { order: "asc" }, { updatedAt: "asc" }],
      });
      for (const sibling of existing) {
        if (sibling.slot !== validated.slot) continue;
        if (sibling.widgetKey === validated.widgetKey) continue;
        const result = await deps.prismaLike.chatWidget.deleteMany({
          where: { sessionId: input.sessionId, widgetKey: sibling.widgetKey },
        });
        // Only fire onEvict when a row actually went away — a no-op
        // delete (row already gone between findMany and deleteMany,
        // which the mutex prevents but a future mutex-less caller
        // could still hit) must not emit a spurious `widget_remove`
        // SSE. Same "emit on effect" discipline the WorkspaceEmitter
        // uses for manual removes.
        if (result.count > 0) {
          deps.onEvict?.(sibling.widgetKey);
        }
      }
    }
    return row;
  };

  const row = isSingleton
    ? await withSlotLock(input.sessionId, validated.slot, doWrite)
    : await doWrite();

  return rowToWidget(row);
}

// Remove a widget by (sessionId, widgetKey). Idempotent — calling
// remove on a widget that's already gone returns `{ removed: false }`
// rather than throwing, which matches Prisma's deleteMany semantics
// and lets callers safely re-emit a remove after a retry.
export async function removeWidget(
  deps: { prismaLike: PrismaLike },
  sessionId: string,
  widgetKey: string,
): Promise<{ removed: boolean }> {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { removed: false };
  }
  if (typeof widgetKey !== "string" || widgetKey.length === 0) {
    return { removed: false };
  }
  const result = await deps.prismaLike.chatWidget.deleteMany({
    where: { sessionId, widgetKey },
  });
  return { removed: result.count > 0 };
}

// Return the widget the caller wants to draw focus to, or null if
// it doesn't exist. The SSE `widget_focus` event is the visible
// effect — this helper just confirms the target exists so the
// client doesn't scroll to a ghost. Marked optional in the W1 spec;
// we include it here because it's a two-line wrapper that keeps the
// focus-by-key contract honest.
export async function focusWidget(
  deps: { prismaLike: PrismaLike },
  sessionId: string,
  widgetKey: string,
): Promise<Widget | null> {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof widgetKey !== "string" || widgetKey.length === 0) return null;
  const row = await deps.prismaLike.chatWidget.findUnique({
    where: { sessionId_widgetKey: { sessionId, widgetKey } },
  });
  if (row === null) return null;
  return rowToWidget(row);
}

// ---- workspace emitter ----
//
// Thin SSE-aware wrapper that binds a `sessionId` + a `send` function
// to the four helpers above. The chat stream instantiates one of
// these per request; tools / dispatch layers call `.upsert(...)`,
// `.remove(...)`, `.focus(...)` instead of touching the DB helpers
// directly. Each call:
//   1. Invokes the matching helper against the injected Prisma.
//   2. Emits the corresponding SSE event IFF the DB operation had a
//      visible effect (write succeeded, delete hit a row, focus
//      target exists).
// That "emit only on effect" rule keeps the client's event stream
// honest — a stray `widget_remove` for a non-existent key wastes
// cycles and could desync optimistic state.
//
// `.snapshot()` is the one-shot call the stream makes right after
// `send("session", ...)` — it feeds the client whatever widgets are
// already persisted so a reload recovers the dashboard without
// replaying the transcript (this is the W1 acceptance criterion
// verbatim from GPT's direction note).
//
// W1 deliberately does NOT call `.upsert(...)`/`.remove(...)` from
// anywhere — tools still emit directives, and the compat bridge
// stays in place. W3 is where the dispatch layer starts calling
// these methods as tools migrate. Shipping the emitter now means W3
// is a pure code-move, not an API design exercise.
export type SseSend = (event: string, data: unknown) => void;

export type WorkspaceEmitter = {
  snapshot(): Promise<{ widgets: Widget[]; skipped: number }>;
  upsert(input: Omit<UpsertWidgetInput, "sessionId">): Promise<Widget | null>;
  remove(widgetKey: string): Promise<{ removed: boolean }>;
  focus(widgetKey: string): Promise<Widget | null>;
};

export function createWorkspaceEmitter(
  deps: { prismaLike: PrismaLike },
  sessionId: string,
  send: SseSend,
): WorkspaceEmitter {
  return {
    async snapshot() {
      const result = await listWidgets(deps, sessionId);
      // Emit even when `widgets` is empty — the client uses this
      // frame as the authoritative "no widgets yet, clear any stale
      // state" signal. `skipped` is advisory; a future operator UI
      // can surface "N widgets failed to load" without the client
      // having to re-fetch.
      send("workspace_snapshot", {
        widgets: result.widgets,
        skipped: result.skipped,
      });
      return result;
    },
    async upsert(input) {
      // P8 — collect evicted widgetKeys so we can emit a
      // `widget_remove` SSE per sibling BEFORE `widget_upsert` +
      // `widget_focus`. The order matters for the client: the
      // reducer processes events in arrival order, and the UI
      // should see "old card goes away, new card appears, focus
      // lands on new card" rather than a transient state with two
      // cards in the same singleton slot.
      const evicted: string[] = [];
      const widget = await upsertWidget(
        {
          ...deps,
          onEvict: (widgetKey) => evicted.push(widgetKey),
        },
        { ...input, sessionId },
      );
      for (const widgetKey of evicted) {
        send("widget_remove", { widgetKey });
      }
      if (widget) {
        send("widget_upsert", widget);
        // W4 — an upsert IS the moment the operator's attention
        // should follow. The six migrated tools all ship on a direct
        // operator intent ("list campaigns", "show contacts",
        // "propose send"), so focusing the freshly-written widget
        // gives the dashboard a living-surface feel: refined filters
        // update the same card AND pull it back into view. We emit
        // focus directly (no second findUnique) because we just
        // persisted the row and know it exists.
        send("widget_focus", { widgetKey: widget.widgetKey });
      }
      return widget;
    },
    async remove(widgetKey) {
      const result = await removeWidget(deps, sessionId, widgetKey);
      // Only emit when a row actually went away. Emitting on a
      // no-op delete would force the client to branch on "is this a
      // real removal or a retry echo" — cleaner to make the stream
      // speak effects, not intents.
      if (result.removed) send("widget_remove", { widgetKey });
      return result;
    },
    async focus(widgetKey) {
      const widget = await focusWidget(deps, sessionId, widgetKey);
      // Emit by key (not by full widget object) — the client
      // already has the widget from a prior snapshot / upsert, and
      // the focus signal is purely "scroll / highlight this one".
      if (widget) send("widget_focus", { widgetKey: widget.widgetKey });
      return widget;
    },
  };
}
