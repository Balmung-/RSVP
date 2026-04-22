import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireActiveTenantId } from "@/lib/auth";
import { canSeeCampaignRow } from "@/lib/teams";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const whenFmt = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: TZ,
});

// Print-optimized roster. No Shell, no sidebar, no decoration beyond a thin
// header. Groups attendees by organization; declined + pending listed below
// for completeness (useful at the door for last-minute walk-ups).

export default async function Roster({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { sensitive?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const tenantId = requireActiveTenantId(me);
  const campaign = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!campaign) notFound();
  if (!(await canSeeCampaignRow(me.id, hasRole(me, "admin"), tenantId, campaign.tenantId, campaign.teamId))) notFound();
  // Print roster caps at 5000 rows — a paper roster beyond that is
  // unreadable anyway, and without a cap we'd load and render the
  // entire invitee table into memory for big events.
  const ROSTER_CAP = 5000;
  const invitees = await prisma.invitee.findMany({
    where: { campaignId: params.id },
    include: { response: true },
    orderBy: [{ organization: "asc" }, { fullName: "asc" }],
    take: ROSTER_CAP,
  });
  const totalInvited = await prisma.invitee.count({ where: { campaignId: params.id } });
  const truncated = totalInvited > invitees.length;
  const sensitive = searchParams.sensitive === "1";

  const attending = invitees.filter((i) => i.response?.attending);
  const declined = invitees.filter((i) => i.response && !i.response.attending);
  const pending = invitees.filter((i) => !i.response);

  const groupedAttending = groupByOrg(attending);
  const attendingHeadcount = attending.reduce((s, i) => s + 1 + (i.response?.guestsCount ?? 0), 0);

  return (
    <div className="print-roster min-h-screen bg-white text-ink-900 p-10 print:p-6">
      <style>{`
        @media print {
          @page { size: A4; margin: 16mm; }
          .no-print { display: none !important; }
          .print-roster { font-size: 11px; }
        }
        .print-roster {
          font-family:
            "Noto Naskh Arabic", "Amiri", var(--font-sans),
            -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .print-roster table { width: 100%; border-collapse: collapse; }
        .print-roster th, .print-roster td {
          text-align: start; padding: 6px 10px; border-bottom: 1px solid #e8e8e6;
          font-size: 13px;
        }
        .print-roster th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #5a5a57; }
        .print-roster h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
        .print-roster h2 { font-size: 14px; font-weight: 600; margin-top: 28px; margin-bottom: 8px; }
        .print-roster h3 { font-size: 12px; font-weight: 600; color: #3a3a38; margin-top: 14px; margin-bottom: 6px; }
        .print-roster .meta { font-size: 12px; color: #5a5a57; }
        .print-roster .foot {
          font-size: 10px; color: #5a5a57; text-align: center; margin-top: 40px;
          border-top: 1px solid #e8e8e6; padding-top: 10px;
        }
      `}</style>

      <header className="flex items-start justify-between border-b border-ink-200 pb-4 mb-6">
        <div>
          <h1>{campaign.name}</h1>
          <div className="meta mt-1">
            {campaign.venue ? <>{campaign.venue} · </> : null}
            {campaign.eventAt ? whenFmt.format(campaign.eventAt) : null}
          </div>
          <div className="meta mt-0.5">
            Attending {attending.length} · Headcount {attendingHeadcount} · Declined {declined.length} · Pending {pending.length}
          </div>
          {truncated ? (
            <div className="meta mt-1 text-signal-fail">
              Roster truncated to {ROSTER_CAP.toLocaleString()} of {totalInvited.toLocaleString()} invitees.
              Export CSV for the full list.
            </div>
          ) : null}
        </div>
        <div className="no-print flex items-center gap-3">
          <a
            href={`?${sensitive ? "" : "sensitive=1"}`}
            className="btn-ghost text-xs"
            title={sensitive ? "Hide emails/phones" : "Show full contact details"}
          >
            {sensitive ? "Hide contacts" : "Show contacts"}
          </a>
          <PrintButton />
        </div>
      </header>

      <section>
        <h2>Attending</h2>
        {Object.entries(groupedAttending).map(([org, rows]) => (
          <div key={org}>
            <h3>{org}</h3>
            <table>
              <thead>
                <tr>
                  <th style={{ width: "30%" }}>Name</th>
                  <th style={{ width: "20%" }}>Title</th>
                  <th style={{ width: "18%" }}>Guests</th>
                  <th style={{ width: "16%" }}>Locale</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td><strong>{i.fullName}</strong></td>
                    <td>{i.title ?? ""}</td>
                    <td>{i.response!.guestsCount > 0 ? `+ ${i.response!.guestsCount}` : ""}</td>
                    <td>{i.locale ?? campaign.locale}</td>
                    <td>{i.notes ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {declined.length > 0 ? (
        <section>
          <h2>Declined</h2>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Organization</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              {declined.map((i) => (
                <tr key={i.id}>
                  <td>{i.fullName}</td>
                  <td>{i.organization ?? ""}</td>
                  <td>{i.title ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {pending.length > 0 ? (
        <section>
          <h2>Pending</h2>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Organization</th>
                <th>Email</th>
                <th>Phone</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((i) => (
                <tr key={i.id}>
                  <td>{i.fullName}</td>
                  <td>{i.organization ?? ""}</td>
                  <td>{sensitive ? (i.email ?? "") : redactEmail(i.email)}</td>
                  <td>{sensitive ? (i.phoneE164 ?? "") : redactPhone(i.phoneE164)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <div className="foot">
        Confidential — destroy after the event.
      </div>
    </div>
  );
}

function redactEmail(e: string | null | undefined): string {
  if (!e) return "";
  const at = e.indexOf("@");
  if (at < 0) return "•••";
  return `•••${e.slice(at)}`;
}

function redactPhone(p: string | null | undefined): string {
  if (!p) return "";
  return p.length <= 4 ? p : `${"•".repeat(Math.max(0, p.length - 4))}${p.slice(-4)}`;
}

function groupByOrg<T extends { organization: string | null }>(rows: T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) {
    const key = (r.organization ?? "").trim() || "— Unaffiliated —";
    (out[key] ??= []).push(r);
  }
  return out;
}
