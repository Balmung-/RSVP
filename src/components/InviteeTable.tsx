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
  emailSent: boolean;
  smsSent: boolean;
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
              invitees.map((i) => {
                const checked = selected.has(i.id);
                const isOpen = selectedInviteeId === i.id;
                const r = i.response;
                const tone = r ? (r.attending ? "live" : "fail") : "wait";
                const label = r ? (r.attending ? "attending" : "declined") : "pending";
                return (
                  <tr
                    key={i.id}
                    className={clsx(isOpen && "bg-ink-50")}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <label className="sr-only" htmlFor={`sel-${i.id}`}>Select {i.fullName}</label>
                      <input
                        id={`sel-${i.id}`}
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(i.id)}
                        className="accent-ink-900"
                      />
                    </td>
                    <td>
                      <Link
                        href={`${baseHref}invitee=${i.id}`}
                        className="block"
                      >
                        <div className="font-medium text-ink-900 hover:underline">{i.fullName}</div>
                        {i.title || i.organization ? (
                          <div className="text-xs text-ink-400 mt-0.5">
                            {[i.title, i.organization].filter(Boolean).join(" · ")}
                          </div>
                        ) : null}
                      </Link>
                    </td>
                    <td className="text-ink-600">
                      {i.email ?? <span className="text-ink-300">—</span>}
                    </td>
                    <td className="text-ink-600 tabular-nums">
                      {i.phoneE164 ?? <span className="text-ink-300">—</span>}
                    </td>
                    <td>
                      <div className="flex items-center gap-2 text-xs text-ink-500">
                        <span className={i.emailSent ? "text-signal-live" : "text-ink-300"}>email</span>
                        <span className="text-ink-300">·</span>
                        <span className={i.smsSent ? "text-signal-live" : "text-ink-300"}>sms</span>
                      </div>
                    </td>
                    <td><Badge tone={tone}>{label}</Badge></td>
                    <td className="text-right tabular-nums text-ink-600">
                      {r?.attending ? r.guestsCount : 0}
                      <span className="text-ink-300"> / {i.guestsAllowed}</span>
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
          className="fixed bottom-8 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 rounded-full bg-ink-900 text-ink-0 pl-5 pr-3 py-2 shadow-lift"
        >
          <span className="text-sm tabular-nums">{selected.size} selected</span>
          <span className="h-4 w-px bg-ink-700" />
          <form action={resendBulkAction} className="inline-flex items-center gap-2">
            {selectedArr.map((id) => (
              <input key={id} type="hidden" name="id" value={id} />
            ))}
            <button
              name="channel"
              value="email"
              className="rounded-full bg-ink-700 hover:bg-ink-600 px-3 py-1 text-xs transition-colors"
              type="submit"
            >
              Resend email
            </button>
            <button
              name="channel"
              value="sms"
              className="rounded-full bg-ink-700 hover:bg-ink-600 px-3 py-1 text-xs transition-colors"
              type="submit"
            >
              Resend SMS
            </button>
          </form>
          <form action={deleteBulkAction}>
            {selectedArr.map((id) => (
              <input key={id} type="hidden" name="id" value={id} />
            ))}
            <button
              className="rounded-full text-signal-fail hover:bg-ink-800 px-3 py-1 text-xs transition-colors"
              type="submit"
              onClick={(e) => {
                if (!window.confirm(`Delete ${selected.size} invitee${selected.size === 1 ? "" : "s"}? Responses and invitation history are deleted too.`)) e.preventDefault();
              }}
            >
              Delete
            </button>
          </form>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="rounded-full hover:bg-ink-800 px-3 py-1 text-xs transition-colors ml-1"
          >
            Clear
          </button>
        </div>
      ) : null}
    </>
  );
}
