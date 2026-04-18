import Link from "next/link";

// Collapses the old "pending approval" and "at-risk" banners into one
// thin horizontal strip. Each item is a single line: tone dot, short
// copy, optional detail, optional action link. Renders nothing when
// there's nothing to flag — calm by default.
//
// Directive fit: fewer focal points, horizontally continuous,
// complexity hidden until needed. The boxed signal-fail/hold fields
// with heavy borders are gone; in their place, a quiet inline row.

export type AttentionItem = {
  key: string;
  tone: "warn" | "fail";
  text: string;
  detail?: string | null;
  action?: { label: string; href: string } | null;
};

export function AttentionStrip({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 max-w-4xl">
      {items.map((it) => (
        <div
          key={it.key}
          className="flex items-center gap-3 text-mini"
          role="status"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full shrink-0 ${it.tone === "fail" ? "bg-signal-fail" : "bg-signal-hold"}`}
            aria-hidden
          />
          <span className="text-ink-900 truncate">
            {it.text}
            {it.detail ? (
              <span className="text-ink-500 ms-2">{it.detail}</span>
            ) : null}
          </span>
          {it.action ? (
            <Link
              href={it.action.href}
              className="ms-auto text-ink-500 hover:text-ink-900 underline-offset-4 hover:underline shrink-0"
            >
              {it.action.label}
            </Link>
          ) : null}
        </div>
      ))}
    </div>
  );
}
