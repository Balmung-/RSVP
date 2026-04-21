"use client";

import type { Turn } from "./types";

// Local optimistic transcript append for confirm/import routes.
//
// `/api/chat/confirm/[messageId]` persists a settled assistant row on
// the server, but the open /chat session has no SSE channel on that
// POST. We append the same summary locally so the operator sees the
// outcome immediately, then let ChatWorkspace re-fetch the session
// snapshot to reconcile ids + widgets with the DB.
//
// Why this helper exists as a pure function:
//   - lets unit tests pin the "no refresh needed" transcript effect
//     without a React harness
//   - keeps the client callback tiny in ChatWorkspace
//   - centralises the non-empty-summary guard so confirm_send and
//     confirm_import don't each invent their own local append rule

export type ConfirmedOutcome = {
  summary: string;
  isError: boolean;
};

export function appendConfirmedOutcome(
  prev: Turn[],
  outcome: ConfirmedOutcome,
): Turn[] {
  if (typeof outcome.summary !== "string") return prev;
  if (outcome.summary.trim().length === 0) return prev;
  return [
    ...prev,
    {
      kind: "assistant",
      id: newLocalTurnId(),
      blocks: [{ type: "text", text: outcome.summary }],
      streaming: false,
    },
  ];
}

function newLocalTurnId(): string {
  return `local_confirm_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}
