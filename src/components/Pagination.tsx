import Link from "next/link";
import clsx from "clsx";

// Minimal pager. Three signals: where you are, one step each way.
// Hidden entirely when not needed.
export function Pagination({
  page,
  pageSize,
  total,
  hrefFor,
}: {
  page: number;
  pageSize: number;
  total: number;
  hrefFor: (p: number) => string;
}) {
  if (total <= pageSize) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const prev = page > 1 ? hrefFor(page - 1) : null;
  const next = page < pages ? hrefFor(page + 1) : null;

  return (
    <div className="flex items-center justify-between mt-6 text-xs text-ink-500">
      <span className="tabular-nums">
        {from}–{to} of {total}
      </span>
      <div className="inline-flex items-center gap-1">
        <Link
          href={prev ?? "#"}
          aria-disabled={!prev}
          className={clsx(
            "rounded-md px-3 py-1.5 hover:bg-ink-100",
            !prev && "pointer-events-none text-ink-300",
          )}
        >
          ←
        </Link>
        <span className="tabular-nums text-ink-700 px-2">
          {page} / {pages}
        </span>
        <Link
          href={next ?? "#"}
          aria-disabled={!next}
          className={clsx(
            "rounded-md px-3 py-1.5 hover:bg-ink-100",
            !next && "pointer-events-none text-ink-300",
          )}
        >
          →
        </Link>
      </div>
    </div>
  );
}
