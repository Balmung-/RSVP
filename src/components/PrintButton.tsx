"use client";

// Client-only button that invokes window.print. No animation, no state —
// just a thin wrapper so server-rendered print pages can offer a Print CTA.

export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button type="button" onClick={() => window.print()} className="btn-ghost">
      {label}
    </button>
  );
}
