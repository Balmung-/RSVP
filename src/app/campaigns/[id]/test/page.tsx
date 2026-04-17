import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { prisma } from "@/lib/db";
import { isAuthed, requireRole } from "@/lib/auth";
import { testSendEmail, testSendSms } from "@/lib/testsend";

export const dynamic = "force-dynamic";

async function run(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const channel = String(formData.get("channel") ?? "email");
  const to = String(formData.get("to") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim() || undefined;
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) redirect(`/campaigns/${campaignId}`);
  const res =
    channel === "sms"
      ? await testSendSms(campaign!, to, name)
      : await testSendEmail(campaign!, to, name);
  const qs = new URLSearchParams({
    to,
    name: name ?? "",
    channel,
    status: res.ok ? "sent" : "failed",
    detail: res.ok ? res.providerId : res.error,
  });
  redirect(`/campaigns/${campaignId}/test?${qs.toString()}`);
}

export default async function TestSend({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { to?: string; name?: string; channel?: string; status?: string; detail?: string };
}) {
  if (!(await isAuthed())) redirect("/login");
  const c = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!c) notFound();
  const action = run.bind(null, c.id);

  const lastStatus = searchParams.status;
  const lastChannel = searchParams.channel;
  const lastDetail = searchParams.detail;

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
      <div className="panel max-w-2xl p-10">
        <p className="text-sm text-ink-500 mb-6">
          Sends the current template through the configured provider. Does not create an Invitee,
          does not count toward campaign stats. Ideal for verifying the rendered output before
          the real blast.
        </p>
        <form action={action} className="grid grid-cols-2 gap-6">
          <Field label="Channel">
            <select name="channel" className="field" defaultValue={lastChannel ?? "email"}>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
            </select>
          </Field>
          <Field label="Display name">
            <input
              name="name"
              className="field"
              placeholder="Jane Harrison"
              defaultValue={searchParams.name ?? ""}
            />
          </Field>
          <Field label="Recipient (email or phone)" className="col-span-2">
            <input
              name="to"
              className="field"
              placeholder="jane@example.com or +9665..."
              required
              defaultValue={searchParams.to ?? ""}
            />
          </Field>
          <div className="col-span-2 flex items-center justify-between">
            <Link href={`/campaigns/${c.id}`} className="btn-ghost">Cancel</Link>
            <button className="btn-primary">Send test</button>
          </div>
        </form>

        {lastStatus ? (
          <div
            className={`mt-8 flex items-start gap-3 rounded-lg border p-4 ${
              lastStatus === "sent"
                ? "border-signal-live/30 bg-signal-live/5"
                : "border-signal-fail/30 bg-signal-fail/5"
            }`}
            role="status"
          >
            <span className={`dot mt-1.5 ${lastStatus === "sent" ? "bg-signal-live" : "bg-signal-fail"}`} />
            <div className="text-sm">
              <div className="font-medium text-ink-900">
                {lastStatus === "sent" ? "Delivered to provider" : "Failed"}
              </div>
              <div className="text-xs text-ink-500 mt-0.5 font-mono">
                {lastChannel} · {lastDetail}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-[11px] uppercase tracking-wider text-ink-400">{label}</span>
      {children}
    </label>
  );
}
