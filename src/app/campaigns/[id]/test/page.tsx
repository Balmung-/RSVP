import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Icon } from "@/components/Icon";
import { Field } from "@/components/Field";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireRole } from "@/lib/auth";
import { canSeeCampaign, canSeeCampaignRow } from "@/lib/teams";
import { testSendEmail, testSendSms } from "@/lib/testsend";
import { renderEmail, renderSms, type Recipient } from "@/lib/preview";
import { newRsvpToken } from "@/lib/tokens";
import { logAction } from "@/lib/audit";
import { setFlash } from "@/lib/flash";

export const dynamic = "force-dynamic";

// Test send — verify how the current campaign's template renders and
// delivers through the configured provider, without touching invitees,
// stats, or Invitation rows.
//
// Flow: preview (server-rendered from the synthetic recipient) shown
// alongside the form, so operators see the rendered copy before they
// hit send. Result lands via flash cookie on the next render — keeps
// the URL clean (no provider-error fragments in query strings) and
// lets the page refresh without re-triggering the "last result" panel.

type SearchParams = { to?: string; name?: string; channel?: string };

async function run(campaignId: string, formData: FormData) {
  "use server";
  const me = await requireRole("editor");
  if (!(await canSeeCampaign(me.id, hasRole(me, "admin"), campaignId))) {
    redirect(`/campaigns`);
  }
  const channel = String(formData.get("channel") ?? "email");
  const to = String(formData.get("to") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim() || undefined;
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) redirect(`/campaigns/${campaignId}`);
  const res =
    channel === "sms"
      ? await testSendSms(campaign!, to, name)
      : await testSendEmail(campaign!, to, name);

  // 120-char cap on the detail — provider error strings sometimes
  // include partial API keys in truncated stacks, and the flash
  // string ships in a cookie so tighter is safer.
  const detail = String(res.ok ? res.providerId : res.error ?? "").slice(0, 120);

  await logAction({
    kind: res.ok ? "test_send.ok" : "test_send.fail",
    refType: "campaign",
    refId: campaignId,
    data: { channel, to: to.slice(0, 200), detail },
  });

  if (res.ok) {
    setFlash({
      kind: "success",
      text: `Test ${channel} delivered to provider.`,
      detail: `To ${to} · ${detail}`,
    });
  } else {
    setFlash({
      kind: "warn",
      text: `Test ${channel} failed — ${detail || "unknown error"}.`,
    });
  }
  // Preserve the recipient + channel so the operator can tweak and
  // retry without retyping. Never echo detail in the URL.
  const qs = new URLSearchParams({ to, channel, ...(name ? { name } : {}) });
  redirect(`/campaigns/${campaignId}/test?${qs.toString()}`);
}

function buildPreview(
  campaign: NonNullable<Awaited<ReturnType<typeof prisma.campaign.findUnique>>>,
  name: string,
): {
  email: { subject: string; text: string; html: string };
  sms: { body: string };
} {
  const synthetic: Recipient = {
    fullName: name || "Test Recipient",
    title: null,
    organization: null,
    locale: null,
    rsvpToken: newRsvpToken(),
  };
  return {
    email: renderEmail(campaign, synthetic),
    sms: renderSms(campaign, synthetic),
  };
}

export default async function TestSend({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: SearchParams;
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const c = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!c) notFound();
  if (!(await canSeeCampaignRow(me.id, hasRole(me, "admin"), c.teamId))) notFound();
  const action = run.bind(null, c.id);

  // Default the recipient field to the signed-in user's email so the
  // common "test-to-self" flow is one click. They can still overwrite.
  const defaultTo = searchParams.to ?? me.email;
  const defaultChannel =
    searchParams.channel === "sms" || searchParams.channel === "email"
      ? searchParams.channel
      : "email";
  const defaultName = searchParams.name ?? "";

  const preview = buildPreview(c, defaultName);

  return (
    <Shell
      title="Test send"
      crumb={
        <span>
          <Link href="/campaigns" className="hover:underline">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Test send</span>
        </span>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-8 max-w-6xl">
        <div className="panel p-8">
          <p className="text-sm text-ink-500 mb-6 leading-relaxed">
            Renders the current template through the configured provider.
            Doesn&apos;t create an Invitee or count toward campaign stats.
            The recipient sees a <code className="font-mono text-ink-700">[TEST]</code>{" "}
            banner so they know it&apos;s a preview.
          </p>
          <form action={action} className="grid grid-cols-2 gap-5">
            <Field label="Channel">
              <select name="channel" className="field" defaultValue={defaultChannel}>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
              </select>
            </Field>
            <Field label="Display name">
              <input
                name="name"
                className="field"
                placeholder="Jane Harrison"
                defaultValue={defaultName}
                maxLength={120}
              />
            </Field>
            <Field label="Recipient (email or phone)" className="col-span-2">
              <input
                name="to"
                className="field"
                placeholder="jane@example.com or +9665..."
                required
                defaultValue={defaultTo}
                maxLength={200}
              />
              <span className="text-mini text-ink-400 mt-1">
                Defaults to your own address — change to test-send to a colleague.
              </span>
            </Field>
            <div className="col-span-2 flex items-center justify-between pt-2">
              <Link href={`/campaigns/${c.id}`} className="btn btn-ghost text-mini">
                Back to campaign
              </Link>
              <button className="btn btn-primary">
                <Icon name="send" size={14} />
                Send test
              </button>
            </div>
          </form>
        </div>

        <div className="flex flex-col gap-6">
          <PreviewCard channel="email" label="Email preview" preview={preview.email} />
          <PreviewCard channel="sms" label="SMS preview" preview={{ body: preview.sms.body }} />
        </div>
      </div>
    </Shell>
  );
}

function PreviewCard({
  channel,
  label,
  preview,
}: {
  channel: "email" | "sms";
  label: string;
  preview: { subject?: string; text?: string; body?: string };
}) {
  return (
    <div className="panel p-6">
      <div className="flex items-center gap-2 mb-3">
        <Icon name={channel === "email" ? "mail" : "message"} size={14} className="text-ink-500" />
        <span className="text-micro uppercase tracking-wider text-ink-400">{label}</span>
      </div>
      {preview.subject ? (
        <div className="text-sm text-ink-900 font-medium mb-2 truncate">{preview.subject}</div>
      ) : null}
      <pre className="text-mini text-ink-600 whitespace-pre-wrap font-sans leading-relaxed max-h-80 overflow-auto">
        {preview.text ?? preview.body}
      </pre>
    </div>
  );
}

