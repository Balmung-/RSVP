import Link from "next/link";
import type { Template } from "@prisma/client";
import { Icon } from "./Icon";

// Compact chooser for loading library copy into a campaign form.
// The picker only manipulates query params; the page re-reads the
// selected template and seeds the form defaults on the server.

export function TemplatePicker({
  templates,
  selected,
  baseHref,
  label = "Start from a template",
  paramKey = "tpl",
}: {
  templates: Template[];
  selected?: string | null;
  baseHref: string;
  label?: string;
  paramKey?: string;
}) {
  if (templates.length === 0) return null;
  return (
    <details className="panel-quiet mb-4 max-w-3xl" open={!!selected}>
      <summary className="cursor-pointer flex items-center gap-2 px-5 py-3 text-body text-ink-700 select-none hover:bg-ink-50 rounded-t-[14px]">
        <Icon name="file-text" size={14} className="text-ink-500" />
        {label}
        {selected ? <span className="text-mini text-ink-400 ms-2">loaded</span> : null}
      </summary>
      <ul className="border-t border-ink-100 divide-y divide-ink-100">
        {templates.map((t) => {
          const href = withParam(baseHref, paramKey, t.id);
          const isSelected = selected === t.id;
          return (
            <li key={t.id}>
              <Link
                href={href}
                className={`flex items-center justify-between px-5 py-3 transition-colors ${
                  isSelected ? "bg-ink-50" : "hover:bg-ink-50"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-body text-ink-900">
                    <Icon name={t.kind === "email" ? "mail" : "message"} size={12} className="text-ink-500" />
                    {t.name}
                    <span className="text-mini uppercase text-ink-400">{t.locale}</span>
                  </div>
                  {t.subject ? (
                    <div className="text-mini text-ink-500 mt-0.5 truncate max-w-xl">{t.subject}</div>
                  ) : null}
                </div>
                {isSelected ? <Icon name="check" size={14} className="text-signal-live" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      {selected ? (
        <div className="px-5 py-3 border-t border-ink-100 text-end">
          <Link href={stripParam(baseHref, paramKey)} className="btn btn-ghost text-mini">
            Clear
          </Link>
        </div>
      ) : null}
    </details>
  );
}

function withParam(url: string, key: string, value: string): string {
  const [base, qs] = url.split("?");
  const params = new URLSearchParams(qs ?? "");
  params.set(key, value);
  return `${base}?${params.toString()}`;
}

function stripParam(url: string, key: string): string {
  const [base, qs] = url.split("?");
  if (!qs) return base;
  const params = new URLSearchParams(qs);
  params.delete(key);
  const s = params.toString();
  return s ? `${base}?${s}` : base;
}
