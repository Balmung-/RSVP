"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./Icon";

type StaticCommand = {
  id: string;
  label: string;
  hint?: string;
  href?: string;
  action?: () => void;
  icon: IconName;
  keywords?: string[];
};

type SearchHit = {
  type: "campaign" | "contact";
  id: string;
  label: string;
  hint: string;
  href: string;
};

// Global command palette. ⌘K / Ctrl+K opens; ? opens the shortcut cheat.
// Static navigation commands + dynamic search across campaigns + contacts.
// Everything keyboard-driven: ↑/↓ moves, Enter picks, Esc closes.

export function CommandPalette({ isAdmin = false, teamsOn = false }: { isAdmin?: boolean; teamsOn?: boolean }) {
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const staticCommands: StaticCommand[] = useMemo(() => {
    const base: StaticCommand[] = [
      { id: "go-home", label: "Overview", hint: "Dashboard", href: "/", icon: "dashboard", keywords: ["dashboard", "home"] },
      { id: "go-campaigns", label: "Campaigns", href: "/campaigns", icon: "calendar-check" },
      { id: "go-contacts", label: "Contacts", href: "/contacts", icon: "users" },
      { id: "go-templates", label: "Templates", href: "/templates", icon: "file-text" },
      { id: "go-inbox", label: "Inbox", href: "/inbox", icon: "inbox" },
      { id: "go-chat", label: "Chat", hint: "AI assistant", href: "/chat", icon: "message", keywords: ["ai", "assistant", "chatbot"] },
      { id: "new-campaign", label: "New campaign", hint: "Create", href: "/campaigns/new", icon: "plus" },
      { id: "new-contact", label: "New contact", hint: "Add to address book", href: "/contacts/new", icon: "user-plus" },
      { id: "new-template", label: "New template", href: "/templates/new", icon: "plus" },
      { id: "go-settings", label: "Settings", href: "/settings", icon: "settings" },
      { id: "change-password", label: "Change password", href: "/account/password", icon: "settings" },
    ];
    if (teamsOn) base.push({ id: "go-teams", label: "Teams", href: "/teams", icon: "tag" });
    if (isAdmin) {
      base.push({ id: "go-users", label: "People", href: "/users", icon: "user-plus" });
      base.push({ id: "go-events", label: "Activity log", href: "/events", icon: "list" });
      base.push({ id: "go-deliverability", label: "Deliverability", hint: "Chase failed sends", href: "/deliverability", icon: "warning" });
      base.push({ id: "go-unsubscribes", label: "Unsubscribes", hint: "Audit opt-outs", href: "/unsubscribes", icon: "eye-off" });
      base.push({ id: "go-approvals", label: "Approvals", href: "/approvals", icon: "circle-alert" });
    }
    return base;
  }, [isAdmin, teamsOn]);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setCursor(0);
    setHits([]);
  }, []);

  // Two-key "g <x>" navigation à la Gmail. The prefix window is
  // bounded by a ref timer so a lone `g` doesn't freeze other keys;
  // arrival of any non-recognized second key clears the state.
  const gPrefixRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gActive = useRef(false);
  const clearGPrefix = useCallback(() => {
    gActive.current = false;
    if (gPrefixRef.current) {
      clearTimeout(gPrefixRef.current);
      gPrefixRef.current = null;
    }
  }, []);

  // Global shortcuts.
  useEffect(() => {
    // g <x> destinations. Scoped to routes that actually exist for
    // the current role — the navigation menu already knows what's
    // visible, we mirror that here so an editor pressing "g a" for
    // approvals silently falls through instead of 404'ing.
    const gRoutes: Record<string, string> = {
      h: "/",
      c: "/campaigns",
      p: "/contacts",
      t: "/templates",
      i: "/inbox",
      s: "/settings",
      ...(isAdmin
        ? {
            a: "/approvals",
            d: "/deliverability",
            u: "/unsubscribes",
            e: "/events",
          }
        : {}),
      ...(teamsOn ? { m: "/teams" } : {}),
    };

    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inField = !!target?.closest("input, textarea, select, [contenteditable='true']");
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        clearGPrefix();
        return;
      }
      // ⌘J / Ctrl+J jumps straight to the AI chat assistant.
      // Separate from `⌘K` (command palette) because jumping to
      // chat is a single-purpose action the operator repeats —
      // going through the palette would be two keystrokes + an
      // Enter every time.
      //
      // Browser conflict note: Chrome / Firefox bind Ctrl+J to
      // the Downloads panel. `preventDefault()` overrides on
      // both. Safari reserves ⌘J more strictly and may still
      // open Downloads; Safari users have the `/` palette + the
      // AvatarMenu "Chat" link as fallbacks. Accepted tradeoff —
      // ⌘J is the shortcut operators will expect from Slack /
      // Discord / Linear-style chat surfaces.
      if (meta && e.key.toLowerCase() === "j") {
        e.preventDefault();
        router.push("/chat");
        close();
        clearGPrefix();
        return;
      }
      if (e.key === "Escape") {
        if (help) setHelp(false);
        else if (open) close();
        clearGPrefix();
        return;
      }
      if (inField || open || help) return;

      if (e.key === "/") {
        e.preventDefault();
        setOpen(true);
        clearGPrefix();
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setHelp(true);
        clearGPrefix();
        return;
      }

      // Two-key navigation. If we're mid-prefix and the key resolves,
      // navigate; otherwise arm / re-arm the prefix on 'g'.
      if (gActive.current) {
        const key = e.key.toLowerCase();
        const dest = gRoutes[key];
        clearGPrefix();
        if (dest) {
          e.preventDefault();
          router.push(dest);
        }
        return;
      }
      if (e.key.toLowerCase() === "g") {
        gActive.current = true;
        if (gPrefixRef.current) clearTimeout(gPrefixRef.current);
        // 1.2s is longer than a two-finger gesture feels but shorter
        // than a typo's attention span — long enough for intent, short
        // enough to not dangle.
        gPrefixRef.current = setTimeout(() => clearGPrefix(), 1200);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, help, close, clearGPrefix, router, isAdmin, teamsOn]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  // Dynamic search.
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const j = (await res.json()) as { results: SearchHit[] };
        if (!cancelled) setHits(j.results ?? []);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open]);

  const filteredStatic = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return staticCommands;
    return staticCommands.filter((c) =>
      (c.label + " " + (c.hint ?? "") + " " + (c.keywords ?? []).join(" "))
        .toLowerCase()
        .includes(query),
    );
  }, [q, staticCommands]);

  const combined: Array<
    | { kind: "static"; cmd: StaticCommand }
    | { kind: "hit"; hit: SearchHit }
  > = useMemo(
    () => [
      ...filteredStatic.map((cmd) => ({ kind: "static" as const, cmd })),
      ...hits.map((hit) => ({ kind: "hit" as const, hit })),
    ],
    [filteredStatic, hits],
  );

  useEffect(() => {
    setCursor(0);
  }, [q]);

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(combined.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = combined[cursor];
      if (!item) return;
      if (item.kind === "static") pick(item.cmd.href, item.cmd.action);
      else pick(item.hit.href);
    }
  }

  function pick(href?: string, action?: () => void) {
    close();
    if (href) router.push(href);
    else action?.();
  }

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-[70] bg-ink-900/30 backdrop-blur-[2px] animate-fade-in"
          onClick={close}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="max-w-xl mx-auto mt-24 panel bg-ink-0 shadow-float overflow-hidden animate-modal-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-ink-100">
              <Icon name="search" size={14} className="text-ink-400 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onInputKey}
                placeholder="Search commands, campaigns, contacts…"
                className="flex-1 bg-transparent outline-none text-body text-ink-900 placeholder:text-ink-400"
              />
              <kbd className="text-mini text-ink-400">ESC</kbd>
            </div>

            <div className="max-h-[60vh] overflow-auto py-1">
              {combined.length === 0 ? (
                <div className="py-12 text-center text-body text-ink-400">
                  {loading ? "Searching…" : q.trim().length < 2 ? "Type to search." : "No matches."}
                </div>
              ) : (
                <ul role="listbox">
                  {combined.map((item, i) => {
                    const active = cursor === i;
                    if (item.kind === "static") {
                      const c = item.cmd;
                      return (
                        <li key={c.id} role="option" aria-selected={active}>
                          <Link
                            href={c.href ?? "#"}
                            onClick={close}
                            onMouseEnter={() => setCursor(i)}
                            className={clsx(
                              "flex items-center gap-3 px-4 py-2.5 transition-colors",
                              active ? "bg-ink-100" : "hover:bg-ink-50",
                            )}
                          >
                            <Icon name={c.icon} size={14} className="text-ink-500 shrink-0" />
                            <span className="flex-1 text-body text-ink-900">{c.label}</span>
                            {c.hint ? <span className="text-mini text-ink-400">{c.hint}</span> : null}
                          </Link>
                        </li>
                      );
                    }
                    const h = item.hit;
                    return (
                      <li key={`${h.type}-${h.id}`} role="option" aria-selected={active}>
                        <Link
                          href={h.href}
                          onClick={close}
                          onMouseEnter={() => setCursor(i)}
                          className={clsx(
                            "flex items-center gap-3 px-4 py-2.5 transition-colors",
                            active ? "bg-ink-100" : "hover:bg-ink-50",
                          )}
                        >
                          <Icon
                            name={h.type === "campaign" ? "calendar-check" : "user"}
                            size={14}
                            className="text-ink-500 shrink-0"
                          />
                          <span className="flex-1 text-body text-ink-900 truncate">{h.label}</span>
                          {h.hint ? <span className="text-mini text-ink-400 truncate">{h.hint}</span> : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="border-t border-ink-100 px-4 py-2 flex items-center justify-between text-mini text-ink-400">
              <span className="flex items-center gap-3">
                <span><kbd className="px-1.5 py-0.5 rounded bg-ink-100 text-ink-600 text-[10px]">↑↓</kbd> Navigate</span>
                <span><kbd className="px-1.5 py-0.5 rounded bg-ink-100 text-ink-600 text-[10px]">↵</kbd> Open</span>
              </span>
              <span>{combined.length} results</span>
            </div>
          </div>
        </div>
      ) : null}

      {help ? (
        <div
          className="fixed inset-0 z-[70] bg-ink-900/30 backdrop-blur-[2px] animate-fade-in"
          onClick={() => setHelp(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="max-w-md mx-auto mt-24 panel bg-ink-0 shadow-float p-6 animate-modal-in"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sub text-ink-900 mb-4">Keyboard shortcuts</h2>
            <div className="text-micro uppercase tracking-wider text-ink-400 mb-2">Global</div>
            <ul className="flex flex-col gap-2 text-body text-ink-700 mb-5">
              <Shortcut keys={["⌘", "K"]} label="Open command palette" />
              <Shortcut keys={["⌘", "J"]} label="Open AI chat" />
              <Shortcut keys={["/"]} label="Open command palette" />
              <Shortcut keys={["?"]} label="Show this help" />
              <Shortcut keys={["Esc"]} label="Close any dialog" />
            </ul>
            <div className="text-micro uppercase tracking-wider text-ink-400 mb-2">Jump to</div>
            <ul className="flex flex-col gap-2 text-body text-ink-700">
              <Shortcut keys={["g", "h"]} label="Overview" />
              <Shortcut keys={["g", "c"]} label="Campaigns" />
              <Shortcut keys={["g", "p"]} label="Contacts" />
              <Shortcut keys={["g", "t"]} label="Templates" />
              <Shortcut keys={["g", "i"]} label="Inbox" />
              <Shortcut keys={["g", "s"]} label="Settings" />
              {isAdmin ? <Shortcut keys={["g", "a"]} label="Approvals" /> : null}
              {isAdmin ? <Shortcut keys={["g", "d"]} label="Deliverability" /> : null}
              {isAdmin ? <Shortcut keys={["g", "u"]} label="Unsubscribes" /> : null}
              {isAdmin ? <Shortcut keys={["g", "e"]} label="Events" /> : null}
              {teamsOn ? <Shortcut keys={["g", "m"]} label="Teams" /> : null}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <li className="flex items-center justify-between">
      <span>{label}</span>
      <span className="inline-flex items-center gap-1">
        {keys.map((k, i) => (
          <kbd key={i} className="px-2 py-0.5 rounded bg-ink-100 text-ink-700 text-mini font-mono">
            {k}
          </kbd>
        ))}
      </span>
    </li>
  );
}
