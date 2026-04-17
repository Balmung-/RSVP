"use client";

import type { ReactNode } from "react";
import { ConfirmSubmit } from "./ConfirmDialog";

// Kept as a drop-in API wrapper for the earlier call sites. Internally it
// now renders a proper modal (no window.confirm). Tone defaults to danger.

export function ConfirmButton({
  children,
  prompt,
  className,
  tone = "danger",
}: {
  children: ReactNode;
  prompt: string;
  className?: string;
  tone?: "default" | "danger";
}) {
  return (
    <ConfirmSubmit
      title={tone === "danger" ? "Are you sure?" : "Confirm"}
      description={prompt}
      confirmLabel={tone === "danger" ? "Delete" : "Confirm"}
      tone={tone}
      className={className}
    >
      {children}
    </ConfirmSubmit>
  );
}
