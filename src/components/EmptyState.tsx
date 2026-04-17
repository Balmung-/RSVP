import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

// The same shape everywhere — icon → title → one line of copy → optional CTA.
// Replaces the "No foo yet." paragraphs scattered across the app.

export function EmptyState({
  icon = "inbox",
  title,
  children,
  action,
  className,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: { label: string; href: string } | ReactNode;
  className?: string;
}) {
  const renderAction =
    action && typeof action === "object" && "href" in action ? (
      <Link href={action.href} className="btn btn-primary mt-6">
        {action.label}
      </Link>
    ) : (
      action
    );
  return (
    <div className={`flex flex-col items-center justify-center text-center py-20 px-6 ${className ?? ""}`}>
      <span className="h-12 w-12 rounded-2xl bg-ink-100 text-ink-500 grid place-items-center mb-5">
        <Icon name={icon} size={20} />
      </span>
      <h2 className="text-sub text-ink-900">{title}</h2>
      {children ? (
        <p className="text-body text-ink-500 mt-2 max-w-sm leading-relaxed">{children}</p>
      ) : null}
      {renderAction}
    </div>
  );
}
