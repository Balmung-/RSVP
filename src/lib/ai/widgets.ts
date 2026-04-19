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

// Insert or update a widget identified by (sessionId, widgetKey).
// Returns the persisted `Widget` (re-parsed, same shape listWidgets
// emits) on success, or null if validation fails — callers should
// treat null as "don't emit an SSE event, don't claim the write
// happened".
//
// The call is a single Prisma upsert — atomic insert-or-update.
// That matches GPT's W1 contract: "a second write to the same key
// UPDATES in place; never appends a duplicate row."
export async function upsertWidget(
  deps: { prismaLike: PrismaLike },
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
      // Update DOES NOT touch widgetKey or sessionId — those are the
      // stable identity. Everything else is fair game: a tool that
      // re-runs with different filters can change slot, order, or
      // even kind (e.g. campaign_list -> campaign_card after the
      // user narrows to one).
      kind: validated.kind,
      slot: validated.slot,
      props: propsJson,
      order,
      sourceMessageId,
    },
  });

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
      const widget = await upsertWidget(deps, { ...input, sessionId });
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
