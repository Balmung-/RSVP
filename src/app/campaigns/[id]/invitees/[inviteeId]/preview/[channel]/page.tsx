import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { renderEmail, renderSms } from "@/lib/preview";

export const dynamic = "force-dynamic";

export default async function Preview({
  params,
}: {
  params: { id: string; inviteeId: string; channel: string };
}) {
  if (!isAuthed()) redirect("/login");
  if (params.channel !== "email" && params.channel !== "sms") notFound();
  const [campaign, invitee] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: params.id } }),
    prisma.invitee.findUnique({ where: { id: params.inviteeId } }),
  ]);
  if (!campaign || !invitee || invitee.campaignId !== campaign.id) notFound();

  if (params.channel === "email") {
    const { subject, html, locale } = renderEmail(campaign, invitee);
    return (
      <div className="min-h-screen bg-ink-100">
        <TopBar campaignId={campaign.id} inviteeId={invitee.id} channel="email">
          <span className="text-ink-400 text-xs mr-2">Subject</span>
          <span className="text-ink-900 text-sm font-medium truncate">{subject}</span>
          <span className="text-ink-400 text-xs ml-3">· {locale}</span>
        </TopBar>
        <iframe
          title="Email preview"
          srcDoc={html}
          className="w-full h-[calc(100vh-60px)] bg-white"
        />
      </div>
    );
  }

  const { body, locale, dir } = renderSms(campaign, invitee);
  return (
    <div className="min-h-screen bg-ink-100 flex flex-col">
      <TopBar campaignId={campaign.id} inviteeId={invitee.id} channel="sms">
        <span className="text-ink-400 text-xs mr-2">SMS · {locale} · {body.length} chars</span>
      </TopBar>
      <div className="flex-1 flex items-center justify-center p-12">
        <div
          dir={dir}
          className="bg-ink-0 rounded-2xl max-w-sm p-6 shadow-lift whitespace-pre-wrap text-[15px] leading-relaxed text-ink-900"
        >
          {body}
        </div>
      </div>
    </div>
  );
}

function TopBar({
  children,
  campaignId,
  inviteeId,
  channel,
}: {
  children: React.ReactNode;
  campaignId: string;
  inviteeId: string;
  channel: "email" | "sms";
}) {
  const other = channel === "email" ? "sms" : "email";
  return (
    <header className="flex items-center justify-between px-6 py-3 bg-ink-0 border-b border-ink-200">
      <div className="flex items-center gap-2 min-w-0">
        <Link href={`/campaigns/${campaignId}?invitee=${inviteeId}`} className="btn-ghost !px-3 !py-1 text-xs">
          ← Back
        </Link>
        <div className="flex items-center gap-2 min-w-0 ml-2">{children}</div>
      </div>
      <Link
        href={`/campaigns/${campaignId}/invitees/${inviteeId}/preview/${other}`}
        className="btn-ghost text-xs"
      >
        Show {other.toUpperCase()}
      </Link>
    </header>
  );
}
