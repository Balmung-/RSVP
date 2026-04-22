import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentUser, hasRole, endSession } from "@/lib/auth";
import { consumeFlash } from "@/lib/flash";
import { teamsEnabled } from "@/lib/teams";
import { readAdminLocale, adminDict } from "@/lib/adminLocale";
import { getNotifications } from "@/lib/notifications";
import { Icon, type IconName } from "./Icon";
import { Toast } from "./Toast";
import { CommandPalette } from "./CommandPalette";
import { CommandHint } from "./CommandHint";
import { NotificationBell } from "./NotificationBell";
import { AvatarMenu } from "./AvatarMenu";

// One horizontal plane. Top seam holds everything the operator needs
// persistently: brand on the left, primary destinations, right
// cluster for command / alerts / account. No sidebar, no vertical
// chrome. The workspace below gets the full width.
//
// The avatar dropdown is the "recessed tool drawer" - secondary
// destinations plus account and sign-out. Chat is now first-class in
// the top seam instead of being discoverability-hidden.

export async function Shell({
  title,
  crumb,
  actions,
  children,
  compactTitle = false,
}: {
  title: string;
  crumb?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  compactTitle?: boolean;
}) {
  const me = await getCurrentUser();
  const isAdmin = hasRole(me, "admin");
  const flash = consumeFlash();
  const showTeams = teamsEnabled() && isAdmin;
  const locale = readAdminLocale();
  const T = adminDict(locale);
  const notifications = me ? await getNotifications(me.id, isAdmin) : [];

  const avatarItems = buildAvatarItems({ isAdmin, showTeams, locale, overviewLabel: T.overview });

  return (
    <div className="min-h-screen flex flex-col">
      <header className="h-14 shrink-0 flex items-center gap-6 px-6 border-b border-ink-100 bg-ink-0">
        <Link href="/chat" className="flex items-center gap-2.5 shrink-0" aria-label="Einai">
          <span className="h-6 w-6 rounded-md bg-ink-900 grid place-items-center">
            <span className="h-1.5 w-1.5 rounded-full bg-ink-0" />
          </span>
          <span className="text-[15px] font-medium tracking-tight hidden sm:inline">Einai</span>
        </Link>
        <nav className="flex items-center gap-1 min-w-0">
          <TopLink href="/chat" label="Chat" />
          <TopLink href="/overview" label={T.overview} />
          <TopLink href="/campaigns" label={T.campaigns} />
          <TopLink href="/contacts" label={T.contacts} />
          <TopLink href="/templates" label={T.templates} />
          <TopLink href="/inbox" label={T.inbox} />
        </nav>
        <div className="ms-auto flex items-center gap-2 shrink-0">
          <CommandHint />
          <NotificationBell items={notifications} />
          <AvatarMenu email={me?.email ?? null} role={me?.role ?? null} items={avatarItems} />
        </div>
      </header>

      <main className="flex flex-col flex-1 min-w-0">
        {me?.mustChangePassword ? (
          <div className="bg-signal-hold/10 border-b border-signal-hold/30 text-signal-hold px-10 py-2.5 flex items-center justify-between">
            <span className="text-body">
              Your password was set by an admin. Please pick your own before continuing.
            </span>
            <Link href="/account/password" className="btn btn-soft text-mini">
              Change password
            </Link>
          </div>
        ) : null}
        {compactTitle ? (
          <div className="flex items-center justify-between px-10 pt-6 pb-2 gap-4">
            <div className="min-w-0 text-mini text-ink-400 truncate">{crumb ?? title}</div>
            <div className="flex items-center gap-2 shrink-0">{actions}</div>
          </div>
        ) : (
          <div className="flex items-end justify-between px-10 pt-10 pb-6 gap-6">
            <div className="min-w-0">
              {crumb ? <div className="text-mini text-ink-400 mb-1 truncate">{crumb}</div> : null}
              <h1 className="text-section text-ink-900 truncate">{title}</h1>
            </div>
            <div className="flex items-center gap-2 shrink-0">{actions}</div>
          </div>
        )}
        <div className="flex-1 px-10 pb-12 min-w-0">{children}</div>
      </main>
      {flash ? <Toast flash={flash} /> : null}
      <CommandPalette isAdmin={isAdmin} teamsOn={showTeams} />
    </div>
  );
}

function TopLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center h-9 px-3 rounded-md text-body text-ink-600 hover:text-ink-900 hover:bg-ink-100 transition-colors whitespace-nowrap"
    >
      {label}
    </Link>
  );
}

type MenuItem =
  | { kind: "link"; href: string; label: string; icon?: IconName; danger?: boolean }
  | {
      kind: "action";
      action: (fd: FormData) => Promise<void> | void;
      label: string;
      icon?: IconName;
      danger?: boolean;
    }
  | { kind: "divider" };

function buildAvatarItems({
  isAdmin,
  showTeams,
  locale,
  overviewLabel,
}: {
  isAdmin: boolean;
  showTeams: boolean;
  locale: "en" | "ar";
  overviewLabel: string;
}): MenuItem[] {
  const items: MenuItem[] = [
    // Chat sits at the top as a featured primary tool, visually
    // separated from the account-management items below by a
    // divider. Available to all authenticated users - the chat
    // surface itself role-gates individual tools (viewer can
    // list, editor can draft / send).
    { kind: "link", href: "/chat", label: locale === "ar" ? "المحادثة" : "Chat", icon: "message" },
    { kind: "link", href: "/overview", label: overviewLabel, icon: "dashboard" },
    // P16-E - the operator memory surface. Sits next to Chat
    // because the two share a trust context (team-scoped,
    // any-authenticated-user). Shows durable facts the assistant
    // has been taught so the team can audit / curate them.
    { kind: "link", href: "/memories", label: locale === "ar" ? "الذاكرة" : "Memories", icon: "list" },
    { kind: "divider" },
    { kind: "link", href: "/settings", label: locale === "ar" ? "الإعدادات" : "Settings", icon: "settings" },
    { kind: "link", href: "/account/password", label: locale === "ar" ? "تغيير كلمة المرور" : "Change password", icon: "settings" },
    { kind: "link", href: "/account/2fa", label: locale === "ar" ? "التحقق بخطوتين" : "Two-step sign-in", icon: "qr" },
  ];
  if (isAdmin) {
    items.push({ kind: "divider" });
    items.push({ kind: "link", href: "/approvals", label: locale === "ar" ? "الموافقات" : "Approvals", icon: "circle-alert" });
    items.push({ kind: "link", href: "/deliverability", label: locale === "ar" ? "قابلية الإرسال" : "Deliverability", icon: "warning" });
    items.push({ kind: "link", href: "/unsubscribes", label: locale === "ar" ? "المنسحبون" : "Unsubscribes", icon: "eye-off" });
    items.push({ kind: "link", href: "/users", label: locale === "ar" ? "الأشخاص" : "People", icon: "user-plus" });
    if (showTeams) {
      items.push({ kind: "link", href: "/teams", label: locale === "ar" ? "الفرق" : "Teams", icon: "tag" });
    }
    items.push({ kind: "link", href: "/events", label: locale === "ar" ? "السجل" : "Events", icon: "list" });
  }
  items.push({ kind: "divider" });
  items.push({
    kind: "action",
    action: signOutAction,
    label: locale === "ar" ? "تسجيل الخروج" : "Sign out",
    icon: "log-out",
    danger: true,
  });
  return items;
}

async function signOutAction() {
  "use server";
  await endSession();
  redirect("/login");
}
