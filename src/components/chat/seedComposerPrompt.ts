// P8-B — transport for chip clicks to the chat composer.
//
// A workspace widget chip ("Send invites for Summer Gala →") is
// rendered inside the dashboard on the right half of /chat. The
// composer (textarea) lives in the ChatRail on the left half. They
// share a common ancestor (ChatWorkspace) that owns the composer's
// `input` state — but plumbing a setter down into every widget
// renderer is a lot of prop-drilling for what is, conceptually, a
// workspace-level broadcast.
//
// CustomEvent on `window` is the lightest intercomponent wire that
// still preserves:
//   - decoupling: the chip doesn't need to import ChatWorkspace;
//     every widget can fire the same event without knowing what
//     listens.
//   - testability: the target is swappable — production uses
//     `window`, tests supply a plain `EventTarget` so the dispatch
//     + receive roundtrip is observable without a DOM.
//   - safety: the type guard below verifies the `detail` payload
//     before a listener trusts the prompt text, so an unrelated
//     `chat:seed-prompt`-named event from a third-party script
//     won't poison the composer with random input.
//
// Why not a React context: context would require every widget
// renderer to live inside a provider, which the dashboard does —
// but a context-consumer hook has a re-render cost on every
// provider state change, and we only need a one-shot notification.
// EventTarget dispatch is the exact shape for "push-once, no
// subscription state."

export const SEED_PROMPT_EVENT = "chat:seed-prompt";

export type SeedPromptDetail = { prompt: string };

// Narrow subset we actually use so tests can pass a plain
// `new EventTarget()` without needing a full Window stub.
type SeedTarget = Pick<EventTarget, "dispatchEvent">;

// Dispatch a seed-prompt request. In production the caller omits
// `target` and the helper dispatches on `window`; tests inject a
// fresh EventTarget and observe via a listener. SSR-safe: the
// window-fallback is guarded by a `typeof window` check so calling
// this from a server component (which shouldn't happen — chips are
// client-only) degrades to a no-op rather than a ReferenceError.
//
// Input guard: empty/whitespace strings produce no event. That
// saves listeners from having to re-check the detail before using
// it, and avoids a subtle bug where a mis-parameterized chip
// (`prompt: ""`) silently clears the composer.
export function seedComposerPrompt(
  prompt: string,
  target?: SeedTarget,
): void {
  if (typeof prompt !== "string") return;
  if (prompt.trim().length === 0) return;
  const resolvedTarget =
    target ?? (typeof window === "undefined" ? null : window);
  if (!resolvedTarget) return;
  resolvedTarget.dispatchEvent(
    new CustomEvent<SeedPromptDetail>(SEED_PROMPT_EVENT, {
      detail: { prompt },
    }),
  );
}

// Type guard for listeners. `window.addEventListener` gives us the
// bare `Event`; this narrows it to our CustomEvent shape with a
// non-empty string prompt. Listeners that skip this guard would
// have to re-implement the detail validation inline, and a future
// change to the detail shape would silently pass the old check.
//
// Third-party scripts can fire a custom event with the same
// `SEED_PROMPT_EVENT` name; the shape check (`detail.prompt` is a
// non-empty string) is what keeps our listener from writing
// arbitrary strings into the composer.
export function isSeedPromptEvent(
  e: Event,
): e is CustomEvent<SeedPromptDetail> {
  if (e.type !== SEED_PROMPT_EVENT) return false;
  if (!(e instanceof CustomEvent)) return false;
  const detail = e.detail as unknown;
  if (!detail || typeof detail !== "object") return false;
  const prompt = (detail as Record<string, unknown>).prompt;
  return typeof prompt === "string" && prompt.length > 0;
}
