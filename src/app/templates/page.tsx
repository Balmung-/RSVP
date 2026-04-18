import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { listTemplates, type TemplateKind } from "@/lib/templates";
import { FilterPill, FilterLabel } from "@/components/FilterPill";

export const dynamic = "force-dynamic";

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: { kind?: string; locale?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const kind = searchParams.kind === "email" || searchParams.kind === "sms" ? (searchParams.kind as TemplateKind) : undefined;
  const locale = searchParams.locale === "ar" || searchParams.locale === "en" ? searchParams.locale : undefined;
  const templates = await listTemplates({ kind, locale });

  const canWrite = hasRole(me, "editor");

  return (
    <Shell
      title="Templates"
      crumb="Reusable messages"
      actions={
        canWrite ? (
          <Link href="/templates/new" className="btn btn-primary">
            <Icon name="plus" size={14} />
            New template
          </Link>
        ) : null
      }
    >
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <FilterLabel>Kind</FilterLabel>
        <div className="flex items-center gap-1">
          <FilterPill href="/templates" active={!kind}>All</FilterPill>
          <FilterPill
            href={`/templates?kind=email${locale ? `&locale=${locale}` : ""}`}
            active={kind === "email"}
          >
            Email
          </FilterPill>
          <FilterPill
            href={`/templates?kind=sms${locale ? `&locale=${locale}` : ""}`}
            active={kind === "sms"}
          >
            SMS
          </FilterPill>
        </div>
        <FilterLabel>Locale</FilterLabel>
        <div className="flex items-center gap-1">
          <FilterPill
            href={kind ? `/templates?kind=${kind}` : "/templates"}
            active={!locale}
          >
            Any
          </FilterPill>
          <FilterPill
            href={`/templates?locale=en${kind ? `&kind=${kind}` : ""}`}
            active={locale === "en"}
          >
            EN
          </FilterPill>
          <FilterPill
            href={`/templates?locale=ar${kind ? `&kind=${kind}` : ""}`}
            active={locale === "ar"}
          >
            AR
          </FilterPill>
        </div>
        {(kind || locale) ? (
          <Link href="/templates" className="text-mini text-ink-500 hover:text-ink-900 ms-auto">Clear</Link>
        ) : null}
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon="file-text"
          title="No templates yet"
          action={canWrite ? { label: "Create one", href: "/templates/new" } : undefined}
        >
          Save your house style once. Every campaign and stage can load a
          template to seed its subject and body — tweak from there.
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-5xl">
          {templates.map((t) => (
            <li key={t.id}>
              <Link
                href={`/templates/${t.id}/edit`}
                className="panel-quiet p-5 block hover:border-ink-200 transition-colors"
              >
                <div className="flex items-center gap-3 mb-2">
                  <Icon name={t.kind === "email" ? "mail" : "message"} size={14} className="text-ink-500" />
                  <span className="text-sub text-ink-900">{t.name}</span>
                  <Badge tone={t.locale === "ar" ? "muted" : "wait"}>{t.locale}</Badge>
                </div>
                {t.subject ? <div className="text-body text-ink-600 mb-1">{t.subject}</div> : null}
                <div className="text-body text-ink-500 line-clamp-3 whitespace-pre-wrap">{t.body}</div>
                {t.tags ? (
                  <div className="text-mini text-ink-400 mt-3">
                    {t.tags.split(",").map((tag) => tag.trim()).filter(Boolean).map((tag) => `#${tag}`).join(" ")}
                  </div>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
