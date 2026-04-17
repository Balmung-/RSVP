"use client";

import type { ReactNode } from "react";
import clsx from "clsx";

// Click-to-confirm via native window.confirm. Two-step enough for a gov tool
// without the ceremony of a custom modal. Wraps any submit button.

export function ConfirmButton({
  children,
  prompt,
  className,
}: {
  children: ReactNode;
  prompt: string;
  className?: string;
}) {
  return (
    <button
      type="submit"
      className={clsx("btn-danger text-xs", className)}
      onClick={(e) => {
        if (!window.confirm(prompt)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
