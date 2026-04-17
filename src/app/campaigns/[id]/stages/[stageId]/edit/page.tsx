import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { StageForm } from "@/components/StageForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { parseLocalInput } from "@/lib/time";
import {
  updateStage,
  deleteStage,
  AUDIENCE_KINDS,
  STAGE_KINDS,
  type AudienceKind,
  type Channel,
  type StageKind,
} from "@/lib/stages";

export const dynamic = "force-dynamic";

async function save(campaignId: string, stageId: string, formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const kindRaw = String(formData.get("kind") ?? "invite");
  const kind = (STAGE_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as StageKind) : "invite";
  const audRaw = String(formData.get("audience") ?? "all");
  const audience = (AUDIENCE_KINDS as readonly string[]).includes(audRaw) ? (audRaw as AudienceKind) : "all";
  const channels: Channel[] = [];
  if (formData.get("channel_email")) channels.push("email");
  if (formData.get("channel_sms")) channels.push("sms");
  const when = parseLocalInput(String(formData.get("scheduledFor") ?? ""));
  if (channels.length === 0 || !when) {
    redirect(`/campaigns/${campaignId}/stages/${stageId}/edit?e=invalid`);
  }
  await updateStage(stageId, campaignId, {
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

async function remove(campaignId: string, stageId: string) {
  "use server";
  if (!isAuthed()) redirect("/login");
  await deleteStage(stageId, campaignId);
  redirect(`/campaigns/${campaignId}`);
}

export default async function EditStage({
  params,
  searchParams,
}: {
  params: { id: string; stageId: string };
  searchParams: { e?: string };
}) {
  if (!isAuthed()) redirect("/login");
  const [c, s] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: params.id } }),
    prisma.campaignStage.findUnique({ where: { id: params.stageId } }),
  ]);
  if (!c || !s || s.campaignId !== c.id) notFound();
  const bound = save.bind(null, c.id, s.id);
  const boundDelete = remove.bind(null, c.id, s.id);
  const error =
    searchParams.e === "invalid"
      ? "Pick at least one channel and a valid fire time."
      : null;
  const locked = s.status === "running" || s.status === "completed";

  return (
    <Shell
      title="Edit stage"
      crumb={
        <span>
          <Link href="/" className="hover:underline">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Edit stage</span>
        </span>
      }
    >
      <div className="panel max-w-3xl p-10">
        {locked ? (
          <p className="text-sm text-ink-500 mb-6">
            This stage is {s.status}. Fields are read-only; you can still delete it.
          </p>
        ) : null}
        {error ? <p role="alert" className="text-sm text-signal-fail mb-6">{error}</p> : null}
        {locked ? null : (
          <StageForm
            stage={s}
            action={bound}
            submitLabel="Save changes"
            cancelHref={`/campaigns/${c.id}`}
          />
        )}
      </div>
      <form action={boundDelete} className="mt-6 max-w-3xl">
        <ConfirmButton prompt="Delete this stage?">Delete stage</ConfirmButton>
      </form>
    </Shell>
  );
}
