import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { getCurrentUser, hasRole, requireActiveTenantId, requireRole } from "@/lib/auth";
import { listTemplates, loadGovernmentTemplatePack, type TemplateKind } from "@/lib/templates";
import { APPROVED_WHATSAPP_TEMPLATES } from "@/lib/whatsapp-template-catalog";
import { FilterPill, FilterLabel } from "@/components/FilterPill";
import { setFlash } from "@/lib/flash";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function loadStarters() {
  "use server";
  const me = await requireRole("editor");
  const res = await loadGovernmentTemplatePack(requireActiveTenantId(me), me.id);
  await logAction({
    kind: "template.starter_pack_loaded",
    actorId: me.id,
    data: { created: res.created, skipped: res.skipped, pack: "government_ministry" },
  });
  setFlash({
    kind: "success",
    text: "Starter templates ready",
    detail:
      res.created > 0
        ? `${res.created} created, ${res.skipped} already present`
        : "All ministry starter templates were already present",
  });
  redirect("/templates");
}

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: { kind?: string; locale?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const tenantId = requireActiveTenantId(me);

  const kind = searchParams.kind === "email" || searchParams.kind === "sms" ? (searchParams.kind as TemplateKind) : undefined;
  const locale = searchParams.locale === "ar" || searchParams.locale === "en" ? searchParams.locale : undefined;
  const templates = await listTemplates(tenantId, { kind, locale });

  const canWrite = hasRole(me, "editor");

  return (
    <Shell
      title="Email & SMS templates"
      crumb="Reusable outbound copy"
      actions={
        canWrite ? (
          <div className="flex items-center gap-2">
            <form action={loadStarters}>
              <button className="btn btn-ghost" type="submit">Load ministry starters</button>
            </form>
            <Link href="/templates/new" className="btn btn-primary">
              <Icon name="plus" size={14} />
              New template
            </Link>
          </div>
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

      <div className="panel-quiet mb-6 max-w-5xl p-5">
        <div className="text-sub text-ink-900 mb-2">Approved WhatsApp templates</div>
        <p className="text-body text-ink-600 mb-3">
          WhatsApp does not use this email/SMS copy library. It uses approved Taqnyat / Meta
          templates selected per campaign in the campaign form.
        </p>
        <ul className="space-y-2 text-body text-ink-700">
          {APPROVED_WHATSAPP_TEMPLATES.map((template) => (
            <li key={template.id} className="flex items-start justify-between gap-4">
              <div>
                <div className="font-medium text-ink-900">{template.label}</div>
                <div className="text-mini text-ink-500">
                  {template.templateName} · {template.language} · {template.kind}
                </div>
              </div>
              {template.note ? <div className="text-mini text-ink-500">{template.note}</div> : null}
            </li>
          ))}
        </ul>
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon="file-text"
          title="No email or SMS templates yet"
          action={canWrite ? { label: "Create one", href: "/templates/new" } : undefined}
        >
          This library only stores reusable email and SMS copy. WhatsApp
          template name, language, and PDF attachment are configured per
          campaign in the campaign form.
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
