import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { StageForm } from "@/components/StageForm";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireRole } from "@/lib/auth";
import { canSeeCampaignRow } from "@/lib/teams";
import { parseLocalInput } from "@/lib/time";
import {
  createStage,
  AUDIENCE_KINDS,
  STAGE_KINDS,
  type AudienceKind,
  type Channel,
  type StageKind,
} from "@/lib/stages";

export const dynamic = "force-dynamic";

async function add(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const kindRaw = String(formData.get("kind") ?? "invite");
  const kind = (STAGE_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as StageKind) : "invite";
  const audRaw = String(formData.get("audience") ?? "all");
  const audience = (AUDIENCE_KINDS as readonly string[]).includes(audRaw) ? (audRaw as AudienceKind) : "all";
  const channels: Channel[] = [];
  if (formData.get("channel_email")) channels.push("email");
  if (formData.get("channel_sms")) channels.push("sms");
  const when = parseLocalInput(String(formData.get("scheduledFor") ?? ""));
  if (channels.length === 0 || !when) {
    redirect(`/campaigns/${campaignId}/stages/new?e=invalid`);
  }
  await createStage(campaignId, {
    kind,
    name: String(formData.get("name") ?? "").trim() || null,
    scheduledFor: when!,
    channels,
    audience,
    subjectEmail: String(formData.get("subjectEmail") ?? "").trim() || null,
    templateEmail: String(formData.get("templateEmail") ?? "").trim() || null,
    templateSms: String(formData.get("templateSms") ?? "").trim() || null,
  });
  redirect(`/campaigns/${campaignId}`);
}

export default async function NewStage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { e?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const c = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!c) notFound();
  if (!(await canSeeCampaignRow(me.id, hasRole(me, "admin"), c.teamId))) notFound();
  const action = add.bind(null, c.id);
  const error =
    searchParams.e === "invalid"
      ? "Pick at least one channel and a fire time in the future."
      : null;

  return (
    <Shell
      title="Add stage"
      crumb={
        <span>
          <Link href="/campaigns" className="hover:underline">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Add stage</span>
        </span>
      }
    >
      <div className="panel max-w-3xl p-10">
        {error ? <p role="alert" className="text-sm text-signal-fail mb-6">{error}</p> : null}
        <StageForm action={action} submitLabel="Schedule stage" cancelHref={`/campaigns/${c.id}`} />
      </div>
    </Shell>
  );
}
