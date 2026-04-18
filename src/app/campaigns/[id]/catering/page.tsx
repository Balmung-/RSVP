import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { canSeeCampaignRow } from "@/lib/teams";
import { parseOptions, type QuestionKind } from "@/lib/questions";

export const dynamic = "force-dynamic";

// Catering / dietary report. Aggregates:
//  - totals (attending + guests → total mouths)
//  - per-question distribution for attending invitees (selects → counts;
//    text → grouped list)
//  - per-contact dietary notes pulled from the linked Contact row

export default async function CateringReport({ params }: { params: { id: string } }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const campaign = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!campaign) notFound();
  if (!(await canSeeCampaignRow(me.id, hasRole(me, "admin"), campaign.teamId))) notFound();

  const [responses, questions] = await Promise.all([
    prisma.response.findMany({
      where: { campaignId: params.id, attending: true },
      include: {
        invitee: {
          include: { contact: { select: { fullName: true, dietary: true, notes: true, vipTier: true } } },
        },
        answers: true,
      },
    }),
    prisma.campaignQuestion.findMany({
      where: { campaignId: params.id },
      orderBy: { order: "asc" },
    }),
  ]);

  const attending = responses.length;
  const totalGuests = responses.reduce((n, r) => n + r.guestsCount, 0);
  const mouths = attending + totalGuests;

  const questionsById = new Map(questions.map((q) => [q.id, q]));

  // Aggregate answers by question.
  type Agg = { prompt: string; kind: QuestionKind; options: string[] | null; tallies: Map<string, number>; texts: Array<{ name: string; value: string }> };
  const aggByQ = new Map<string, Agg>();
  for (const q of questions) {
    aggByQ.set(q.id, {
      prompt: q.prompt,
      kind: q.kind as QuestionKind,
      options: q.options ? parseOptions(q.options) : null,
      tallies: new Map(),
      texts: [],
    });
  }
  for (const r of responses) {
    for (const a of r.answers) {
      const q = questionsById.get(a.questionId);
      if (!q) continue;
      const agg = aggByQ.get(q.id)!;
      const values = a.value.split(/\r?\n/).filter(Boolean);
      if (q.kind === "single_select" || q.kind === "multi_select" || q.kind === "boolean") {
        for (const v of values) agg.tallies.set(v, (agg.tallies.get(v) ?? 0) + 1);
      } else if (q.kind === "number") {
        agg.tallies.set(values.join(", "), (agg.tallies.get(values.join(", ")) ?? 0) + 1);
      } else {
        agg.texts.push({ name: r.invitee.fullName, value: values.join(" ").slice(0, 300) });
      }
    }
  }

  // Contact-sourced dietary notes (not in custom questions).
  const contactDietary = responses
    .map((r) => r.invitee.contact ? { name: r.invitee.fullName, note: r.invitee.contact.dietary, vip: r.invitee.contact.vipTier } : null)
    .filter((x): x is { name: string; note: string | null; vip: string } => !!x && !!x?.note);

  if (attending === 0) {
    return (
      <Shell
        title="Catering summary"
        crumb={
          <span>
            <Link href="/campaigns" className="hover:text-ink-900 transition-colors">Campaigns</Link>
            <span className="mx-1.5 text-ink-300">/</span>
            <Link href={`/campaigns/${campaign.id}`} className="hover:text-ink-900 transition-colors">{campaign.name}</Link>
            <span className="mx-1.5 text-ink-300">/</span>
            <span>Catering</span>
          </span>
        }
      >
        <EmptyState icon="file-text" title="No attendees yet">
          Dietary and accessibility breakdowns appear here once invitees
          start confirming.
        </EmptyState>
      </Shell>
    );
  }

  return (
    <Shell
      title="Catering summary"
      crumb={
        <span>
          <Link href="/campaigns" className="hover:text-ink-900 transition-colors">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${campaign.id}`} className="hover:text-ink-900 transition-colors">{campaign.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Catering</span>
        </span>
      }
      actions={
        <Link href={`/campaigns/${campaign.id}/roster`} className="btn btn-ghost" target="_blank">
          <Icon name="printer" size={14} /> Roster
        </Link>
      }
    >
      <div className="grid grid-cols-3 gap-8 mb-10 max-w-3xl">
        <Stat label="Attending" value={attending} />
        <Stat label="Guests" value={totalGuests} />
        <Stat label="Mouths to feed" value={mouths} hint={`${attending} + ${totalGuests}`} />
      </div>

      {questions.length === 0 && contactDietary.length === 0 ? (
        <p className="text-body text-ink-500 max-w-xl">
          Add a custom question like &ldquo;Dietary restrictions?&rdquo; in Content &rsaquo; Custom
          questions to collect dietary preferences during RSVP.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-10 max-w-3xl">
        {Array.from(aggByQ.values()).map((agg) => (
          <section key={agg.prompt}>
            <h2 className="text-sub text-ink-900 mb-3">{agg.prompt}</h2>
            {agg.tallies.size > 0 ? (
              <ul className="panel divide-y divide-ink-100 overflow-hidden">
                {Array.from(agg.tallies.entries())
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <li key={k} className="flex items-center justify-between px-5 py-3">
                      <span className="text-body text-ink-900">{k}</span>
                      <span className="text-body tabular-nums text-ink-700">
                        <span className="text-ink-900 font-medium">{v}</span>
                        <span className="text-ink-400"> / {attending}</span>
                      </span>
                    </li>
                  ))}
              </ul>
            ) : agg.texts.length > 0 ? (
              <ul className="panel divide-y divide-ink-100 overflow-hidden">
                {agg.texts.map((t, i) => (
                  <li key={i} className="px-5 py-3">
                    <div className="text-body text-ink-900">{t.value}</div>
                    <div className="text-mini text-ink-400 mt-0.5">{t.name}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="panel-quiet p-5 text-body text-ink-400">No answers yet.</div>
            )}
          </section>
        ))}

        {contactDietary.length > 0 ? (
          <section>
            <h2 className="text-sub text-ink-900 mb-1">Address-book dietary notes</h2>
            <p className="text-mini text-ink-500 mb-3">
              Pulled from the linked Contact row, not the RSVP form. Useful for recurring VIPs whose preferences are on file.
            </p>
            <ul className="panel divide-y divide-ink-100 overflow-hidden">
              {contactDietary.map((d, i) => (
                <li key={i} className="flex items-start justify-between px-5 py-3 gap-4">
                  <div className="min-w-0">
                    <div className="text-body text-ink-900">{d.name}</div>
                    <div className="text-mini text-ink-400 mt-0.5">{d.note}</div>
                  </div>
                  {d.vip !== "standard" ? (
                    <span className="text-micro uppercase text-ink-500 shrink-0">{d.vip}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Shell>
  );
}
