// P8-B — "seed next action" prompt table for the workspace widgets.
//
// The dashboard renders a small chip on primary/secondary widget
// cards (the "hero" and "detail" surfaces) that, when clicked, seeds
// a suggested next-action prompt into the chat composer. The chip is
// a nudge, not a dispatcher: it drops text into the textarea; the
// operator reviews it and hits send. This keeps the workspace in
// charge of state and the composer in charge of intent.
//
// Why a prompt TABLE vs per-card inline logic: every card kind gets
// its answer computed in one pure place. Adding a new widget kind
// forces a case here (the `never` exhaustiveness trap at the bottom
// of the switch), so we can't accidentally ship a new primary kind
// without at least deciding "no chip for this one."
//
// Why chips live in primary/secondary only: the action slot already
// has its own terminal buttons (confirm / dismiss), and summary is
// a server-owned rollup with no operator follow-up. Forcing a chip
// there would be visual noise.
//
// Parameterization: where a prompt is more useful with a specific
// reference (e.g. `campaign_card` knowing the campaign's name), the
// function reads that field from `props` with a safe typeof guard
// and falls back to a generic chip if the field is missing or the
// wrong type. The validator already rejects malformed widget props
// at the DB boundary, so a production widget shouldn't hit the
// fallback — but the guard keeps this module a pure no-throw
// function regardless of what's in `props`.

import type { WidgetKind } from "./widget-validate";

// The chip's visible label AND the text seeded into the composer.
// Split so the chip can stay short ("Send invites") while the
// seeded prompt can be more explicit ("Send invites for Summer
// Gala"). Both are plain strings — the composer treats them as the
// operator's own typed input.
export type NextAction = {
  label: string;
  prompt: string;
};

export type NextActionLocale = "en" | "ar";

// Minimal shape the resolver reads. We DO NOT re-run
// `validateWidget` here — the caller (WidgetRenderer) only passes
// widgets that already came off the DB, which went through the
// validator on write. Keeping the input type narrow avoids
// re-stating the whole Widget type here and lets tests call with
// plain objects.
export type WidgetForNextAction = {
  kind: WidgetKind;
  props: Record<string, unknown>;
};

// Per-kind resolver. Returns a `NextAction` when the kind has a
// meaningful next step the operator can take from this card, or
// null when no chip should render.
//
// Exhaustiveness: the `switch` covers every `WidgetKind`, and the
// `never` fallback catches a new kind added to the registry without
// a case here. That fails at compile time — a misconfigured
// dashboard never ships.
export function getNextAction(
  widget: WidgetForNextAction,
  locale: NextActionLocale,
): NextAction | null {
  switch (widget.kind) {
    case "campaign_list":
      // Generic nudge: the operator is browsing campaigns; the
      // most common next step is to open a specific one. We can't
      // know WHICH one from the list shape, so the prompt stays
      // open-ended — the operator names the campaign when they
      // send.
      return locale === "ar"
        ? {
            label: "افتح حملة",
            prompt: "افتح تفاصيل إحدى الحملات في القائمة",
          }
        : {
            label: "Open a campaign",
            prompt: "Open details for one of the campaigns in the list",
          };

    case "campaign_card": {
      // Primary operator action for a specific campaign is sending
      // invites. Interpolate the campaign name when present so the
      // chip reads "Send invites for Summer Gala" rather than a
      // generic pronoun.
      const name = readString(widget.props, "name");
      if (name === null || name.length === 0) {
        return locale === "ar"
          ? {
              label: "إرسال الدعوات",
              prompt: "أرسل الدعوات لهذه الحملة",
            }
          : {
              label: "Send invites",
              prompt: "Send invites for this campaign",
            };
      }
      return locale === "ar"
        ? {
            label: `إرسال دعوات ${name}`,
            prompt: `أرسل الدعوات لحملة ${name}`,
          }
        : {
            label: `Send invites for ${name}`,
            prompt: `Send invites for ${name}`,
          };
    }

    case "contact_table":
      // Browsing contacts; a common follow-up is adding a new one.
      // Not parameterized — the operator supplies the contact
      // details themselves.
      return locale === "ar"
        ? {
            label: "إضافة جهة اتصال",
            prompt: "أضف جهة اتصال جديدة",
          }
        : {
            label: "Add a contact",
            prompt: "Add a new contact",
          };

    case "import_review":
      // The import-review card IS the "pre-commit" surface. The
      // confirm card in the action slot is the actual commit gate
      // (P7), but the operator's mental next step from review is
      // "commit it" — the seed prompt asks the assistant to
      // produce the confirm card.
      return locale === "ar"
        ? {
            label: "تأكيد الاستيراد",
            prompt: "أكّد استيراد هذه البيانات",
          }
        : {
            label: "Commit this import",
            prompt: "Commit this import",
          };

    // The remaining kinds deliberately return null — either they
    // live in non-eligible slots (summary / action) or they're
    // passive views with no obvious "what next" that wouldn't
    // repeat the card's own content.
    case "activity_stream":
    case "file_digest":
    case "confirm_draft":
    case "confirm_send":
    case "confirm_import":
    case "workspace_rollup":
      return null;

    default: {
      // Exhaustiveness trap. If a new `WidgetKind` is added to
      // WIDGET_KINDS and not handled above, TypeScript types
      // `widget.kind` as a non-never type here, which fails to
      // assign to `never`. The runtime fallback returns null so
      // even a (impossible) runtime drift degrades to "no chip"
      // rather than a thrown render.
      const _exhaustive: never = widget.kind;
      void _exhaustive;
      return null;
    }
  }
}

// Safe string reader. Returns `null` when the key is missing, not a
// string, or empty — call sites branch on null and use a fallback
// prompt. We could `trim()` here too, but the validator already
// rejects whitespace-only props strings, so a "\t\t" name won't
// reach this function in practice.
function readString(
  props: Record<string, unknown>,
  key: string,
): string | null {
  const v = props[key];
  return typeof v === "string" ? v : null;
}
