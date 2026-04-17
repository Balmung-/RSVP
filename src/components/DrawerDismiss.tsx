"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Two renders in one component:
// - Without `asCloseButton`: the scrim. Covers the viewport, dismisses on click
//   + Escape key. Low-z so the drawer panel stacks above it.
// - With `asCloseButton`: the header ✕ button. Same dismiss behavior.
//
// Both use router.replace so the navigation doesn't pile up back-stack entries.

export function DrawerDismiss({
  closeHref,
  asCloseButton = false,
}: {
  closeHref: string;
  asCloseButton?: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    if (asCloseButton) return; // one Esc handler per drawer — attached to the scrim
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") router.replace(closeHref);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeHref, asCloseButton, router]);

  if (asCloseButton) {
    return (
      <button
        type="button"
        aria-label="Close drawer"
        onClick={() => router.replace(closeHref)}
        className="btn-ghost !px-3 !py-1 text-xs"
      >
        ✕
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label="Close drawer"
      onClick={() => router.replace(closeHref)}
      className="fixed inset-0 bg-ink-900/20 backdrop-blur-[2px] z-40 cursor-default"
    />
  );
}
