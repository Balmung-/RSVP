"use client";

import clsx from "clsx";
import { Icon } from "@/components/Icon";
import { seedComposerPrompt } from "./seedComposerPrompt";

// P8-B — small chip rendered below primary/secondary widget cards.
// Clicking it seeds `prompt` into the chat composer via the
// CustomEvent transport in `seedComposerPrompt.ts` and nothing
// else — no POST, no side-effect on the widget itself. The
// composer receives the text and the operator decides whether to
// send as-is or edit first.
//
// Visual language: matches the small inline-action style used
// elsewhere (upload button, tool-status pill) — `text-xs`,
// slate palette, subtle hover. Deliberately LESS prominent than
// the in-card status chips and LESS prominent than the card's
// own primary content so it doesn't compete for the operator's
// attention.
//
// Direction: the arrow icon flips between `arrow-right` (en) and
// `arrow-left` (ar) so the "next action" motion reads correctly
// in both reading directions. The Icon registry already has both.

export function NextActionChip({
  label,
  prompt,
  locale,
  className,
}: {
  label: string;
  prompt: string;
  locale: "en" | "ar";
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => seedComposerPrompt(prompt)}
      aria-label={
        locale === "ar"
          ? `اقتراح للكتابة في المحادثة: ${label}`
          : `Suggest to compose in chat: ${label}`
      }
      title={
        locale === "ar"
          ? "يضع هذا الاقتراح في صندوق المحادثة"
          : "Drops this suggestion into the chat composer"
      }
      className={clsx(
        "inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-300",
        className,
      )}
    >
      <span className="truncate max-w-[20ch]">{label}</span>
      <Icon
        name={locale === "ar" ? "arrow-left" : "arrow-right"}
        size={12}
      />
    </button>
  );
}
