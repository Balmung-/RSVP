import Link from "next/link";
import { Stat } from "@/components/Stat";
import { Pagination } from "@/components/Pagination";
import { InviteeTable } from "@/components/InviteeTable";
import type { Campaign } from "@prisma/client";

type TableRow = {
  id: string;
  fullName: string;
  title: string | null;
  organization: string | null;
  email: string | null;
  phoneE164: string | null;
  guestsAllowed: number;
  emailAvailable: boolean;
  smsAvailable: boolean;
  whatsappAvailable: boolean;
  emailSent: boolean;
  smsSent: boolean;
  whatsappSent: boolean;
  response: { attending: boolean; guestsCount: number } | null;
};

export function InviteesTab({
  campaign,
  rows,
  totalInvitees,
  page,
  pageSize,
  searchQuery,
  duplicatesCount,
  stats,
  selectedInviteeId,
  bulkResendAction,
  bulkDeleteAction,
  canWrite,
}: {
  campaign: Campaign;
  rows: TableRow[];
  totalInvitees: number;
  page: number;
  pageSize: number;
  searchQuery: string;
  duplicatesCount: number;
  stats: {
    total: number;
    responded: number;
    attending: number;
    declined: number;
    guests: number;
    headcount: number;
  };
  selectedInviteeId?: string;
  bulkResendAction: (fd: FormData) => Promise<void> | void;
  bulkDeleteAction: (fd: FormData) => Promise<void> | void;
  canWrite: boolean;
}) {
  const hrefFor = (p: number) => {
    const qs = new URLSearchParams({ tab: "invitees" });
    if (searchQuery) qs.set("q", searchQuery);
    qs.set("page", String(p));
    return `/campaigns/${campaign.id}?${qs.toString()}`;
  };
  const baseHref = (() => {
    const qs = new URLSearchParams({ tab: "invitees" });
    if (searchQuery) qs.set("q", searchQuery);
    if (page !== 1) qs.set("page", String(page));
    return `/campaigns/${campaign.id}?${qs.toString()}&`;
  })();

  return (
    <div className="flex flex-col gap-6">
      <section className="grid grid-cols-6 gap-8 py-2">
        <Stat label="Invited" value={stats.total} />
        <Stat
          label="Responded"
          value={stats.responded}
          hint={stats.total ? `${Math.round((stats.responded / stats.total) * 100)}%` : ""}
        />
        <Stat label="Attending" value={stats.attending} />
        <Stat label="Declined" value={stats.declined} />
        <Stat label="Guests +" value={stats.guests} />
        <Stat label="Headcount" value={stats.headcount} />
      </section>

      {duplicatesCount > 0 ? (
        <div className="flex items-center gap-3 text-mini">
          <span className="h-1.5 w-1.5 rounded-full bg-signal-hold shrink-0" aria-hidden />
          <span className="text-ink-900">
            {duplicatesCount} possible duplicate{duplicatesCount === 1 ? "" : "s"} detected
          </span>
          <Link
            href={`/campaigns/${campaign.id}/duplicates`}
            className="ms-auto text-ink-500 hover:text-ink-900 underline-offset-4 hover:underline"
          >
            Review
          </Link>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <form method="get" className="flex-1 max-w-md">
          <input type="hidden" name="tab" value="invitees" />
          <label className="sr-only" htmlFor="invitee-search">Search invitees</label>
          <input
            id="invitee-search"
            name="q"
            defaultValue={searchQuery}
            placeholder="Search name, email, phone, organization"
            className="field"
          />
        </form>
        {canWrite ? (
          <div className="flex items-center gap-2 shrink-0">
            <Link href={`/campaigns/${campaign.id}/invitees/new`} className="btn-ghost text-xs">
              Add invitee
            </Link>
            <Link href={`/campaigns/${campaign.id}/import`} className="btn-ghost text-xs">
              Import file
            </Link>
          </div>
        ) : null}
      </div>
      <p className="text-mini text-ink-500">
        Click an invitee row to open their RSVP details, delivery history, and resend actions.
      </p>

      <InviteeTable
        invitees={rows}
        baseHref={baseHref}
        selectedInviteeId={selectedInviteeId}
        resendBulkAction={bulkResendAction}
        deleteBulkAction={bulkDeleteAction}
      />
      <Pagination page={page} pageSize={pageSize} total={totalInvitees} hrefFor={hrefFor} />
    </div>
  );
}
