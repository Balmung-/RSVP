// Derives a short, human-readable session title from the operator's
// first user message. Used by POST /api/chat when it creates a new
// ChatSession row, so the session-picker (P4) can show a meaningful
// label the moment the operator returns to /chat.
//
// Why derive instead of prompting the operator:
//   - Zero-friction. An operator who types a first ask and walks
//     away still gets a titled row in their picker — no separate
//     "name this conversation" dialog.
//   - Matches the industry convention (ChatGPT, Claude.ai,
//     Linear's AI chat) — the first message IS the title until the
//     user overrides.
//
// Invariants this function holds:
//   - Whitespace-only input returns null — we never save a title
//     like "   " that would render as a blank row.
//   - Internal whitespace runs (newlines, tabs, double spaces)
//     collapse to a single space so a multi-line first message
//     doesn't break the picker's one-line layout.
//   - Titles are capped at TITLE_MAX_CHARS with an ellipsis suffix
//     when truncated — keeps the picker dropdown consistent even
//     for a pasted paragraph.
//   - Pure. No Date.now, no process.env, no prisma — safe to call
//     from anywhere.
//
// Non-goals:
//   - Language-aware summarization. We explicitly don't call the
//     model here: this runs before the first streaming turn starts
//     and has to be fast + free. The truncated raw text is strictly
//     more useful than a spinner.
//   - Emoji / unicode trimming. We trust the operator's input at
//     the character level; truncation happens at the JavaScript
//     UTF-16 code-unit boundary, same as the rest of the app.

// Upper bound on title length. 60 code units fits comfortably in the
// Menu's 14rem width at the default font size with room for the
// date / message-count badge. Longer first messages are truncated
// with an ellipsis.
export const TITLE_MAX_CHARS = 60;

export function deriveSessionTitle(message: string): string | null {
  if (typeof message !== "string") return null;

  // Collapse internal whitespace first, then trim the edges. The
  // order matters for a message like "\n\nhello world\n" — collapse
  // first would leave leading/trailing space-from-collapsed-newlines,
  // which the trim then strips.
  const normalized = message.replace(/\s+/g, " ").trim();

  if (normalized.length === 0) return null;

  if (normalized.length <= TITLE_MAX_CHARS) {
    return normalized;
  }

  // Ellipsis via U+2026 (…). Budget one code unit for the suffix so
  // the total stays within TITLE_MAX_CHARS.
  return `${normalized.slice(0, TITLE_MAX_CHARS - 1)}…`;
}
