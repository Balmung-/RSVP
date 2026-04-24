"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { Badge } from "./Badge";

type Row = {
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

export function InviteeTable({
  invitees,
  baseHref,
  selectedInviteeId,
  resendBulkAction,
  deleteBulkAction,
}: {
  invitees: Row[];
  baseHref: string;
  selectedInviteeId?: string;
  resendBulkAction: (fd: FormData) => Promise<void> | void;
  deleteBulkAction: (fd: FormData) => Promise<void> | void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allSelected = invitees.length > 0 && invitees.every((i) => selected.has(i.id));
  const someSelected = selected.size > 0;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(invitees.map((i) => i.id)));
  }

  const selectedArr = useMemo(() => Array.from(selected), [selected]);
  const selectedRows = useMemo(
    () => invitees.filter((invitee) => selected.has(invitee.id)),
    [invitees, selected],
  );
  const canBulkEmail = selectedRows.some((invitee) => invitee.emailAvailable);
  const canBulkSms = selectedRows.some((invitee) => invitee.smsAvailable);
  const canBulkWhatsApp = selectedRows.some((invitee) => invitee.whatsappAvailable);

  return (
    <>
      <div className="panel rail overflow-hidden">
        <table>
          <thead>
            <tr>
              <th scope="col" className="w-8">
                <label className="sr-only" htmlFor="sel-all">Select all</label>
                <input
                  id="sel-all"
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="accent-ink-900"
                />
              </th>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Phone</th>
              <th scope="col">Channels</th>
              <th scope="col">Response</th>
              <th scope="col" className="text-right">Guests</th>
            </tr>
          </thead>
          <tbody>
            {invitees.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className="py-20 text-center text-ink-400">No matches.</div>
                </td>
              </tr>
            ) : (
              invitees.map((invitee) => {
                const checked = selected.has(invitee.id);
                const isOpen = selectedInviteeId === invitee.id;
                const response = invitee.response;
                const tone = response ? (response.attending ? "live" : "fail") : "wait";
                const label = response ? (response.attending ? "attending" : "declined") : "pending";
                return (
                  <tr key={invitee.id} className={clsx(isOpen && "bg-ink-50")}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <label className="sr-only" htmlFor={`sel-${invitee.id}`}>
                        Select {invitee.fullName}
                      </label>
                      <input
                        id={`sel-${invitee.id}`}
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(invitee.id)}
                        className="accent-ink-900"
                      />
                    </td>
                    <td>
                      <Link href={`${baseHref}invitee=${invitee.id}`} className="block">
                        <div className="font-medium text-ink-900 hover:underline">{invitee.fullName}</div>
                        {invitee.title || invitee.organization ? (
                          <div className="mt-0.5 text-xs text-ink-400">
                            {[invitee.title, invitee.organization].filter(Boolean).join(" - ")}
                          </div>
                        ) : null}
                      </Link>
                    </td>
                    <td className="text-ink-600">
                      {invitee.email ?? <span className="text-ink-300">--</span>}
                    </td>
                    <td className="tabular-nums text-ink-600">
                      {invitee.phoneE164 ?? <span className="text-ink-300">--</span>}
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        {renderChannel(invitee.emailAvailable, invitee.emailSent, "email")}
                        {renderChannel(invitee.smsAvailable, invitee.smsSent, "sms")}
                        {renderChannel(invitee.whatsappAvailable, invitee.whatsappSent, "whatsapp")}
                        {!invitee.emailAvailable && !invitee.smsAvailable && !invitee.whatsappAvailable ? (
                          <span className="text-ink-300">--</span>
                        ) : null}
                      </div>
                    </td>
                    <td><Badge tone={tone}>{label}</Badge></td>
                    <td className="text-right tabular-nums text-ink-600">
                      {response?.attending ? response.guestsCount : 0}
                      <span className="text-ink-300"> / {invitee.guestsAllowed}</span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {someSelected ? (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="fixed bottom-8 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-ink-900 py-2 pl-5 pr-3 text-ink-0 shadow-lift"
        >
          <span className="text-sm tabular-nums">{selected.size} selected</span>
          <span className="h-4 w-px bg-ink-700" />
          <form action={resendBulkAction} className="inline-flex items-center gap-2">
            {selectedArr.map((id) => (
              <input key={id} type="hidden" name="id" value={id} />
            ))}
            {canBulkEmail ? (
              <button
                name="channel"
                value="email"
                className="rounded-full bg-ink-700 px-3 py-1 text-xs transition-colors hover:bg-ink-600"
                type="submit"
              >
                Resend email
              </button>
            ) : null}
            {canBulkSms ? (
              <button
                name="channel"
                value="sms"
                className="rounded-full bg-ink-700 px-3 py-1 text-xs transition-colors hover:bg-ink-600"
                type="submit"
              >
                Resend SMS
              </button>
            ) : null}
            {canBulkWhatsApp ? (
              <button
                name="channel"
                value="whatsapp"
                className="rounded-full bg-ink-700 px-3 py-1 text-xs transition-colors hover:bg-ink-600"
                type="submit"
              >
                Resend WhatsApp
              </button>
            ) : null}
          </form>
          <form action={deleteBulkAction}>
            {selectedArr.map((id) => (
              <input key={id} type="hidden" name="id" value={id} />
            ))}
            <button
              className="rounded-full px-3 py-1 text-xs text-signal-fail transition-colors hover:bg-ink-800"
              type="submit"
              onClick={(e) => {
                if (!window.confirm(`Delete ${selected.size} invitee${selected.size === 1 ? "" : "s"}? Responses and invitation history are deleted too.`)) {
                  e.preventDefault();
                }
              }}
            >
              Delete
            </button>
          </form>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-1 rounded-full px-3 py-1 text-xs transition-colors hover:bg-ink-800"
          >
            Clear
          </button>
        </div>
      ) : null}
    </>
  );
}

function renderChannel(active: boolean, sent: boolean, label: string) {
  if (!active) return null;
  return <Badge tone={sent ? "live" : "muted"}>{label}</Badge>;
}
