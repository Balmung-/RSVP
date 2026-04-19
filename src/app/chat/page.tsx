import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { getCurrentUser } from "@/lib/auth";
import { readAdminLocale, readAdminCalendar } from "@/lib/adminLocale";

// Standalone chat page — the primary entry point to the AI
// assistant. Surfaced from three places as of Push 8:
//   - AvatarMenu "Chat" link (top of the dropdown, featured)
//   - CommandPalette "Chat" item (search `/` or `⌘K`, type "chat")
//   - Global `⌘J` / `Ctrl+J` shortcut (direct navigation)
// The page used to describe itself as a smoke-test route while the
// shell integration was deferred; with Push 8 live the panel is
// just a regular app surface.
//
// The page is a server component: it reads the admin locale/calendar
// cookies plus APP_TIMEZONE on the server and threads them down as
// props. `formatAdminDate` can't run on the client (it reads cookies
// via next/headers), so directives get their own client-friendly
// formatter that takes the same inputs explicitly.

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();
  const tz = process.env.APP_TIMEZONE ?? "Asia/Riyadh";

  return (
    <Shell title={locale === "ar" ? "المحادثة" : "Chat"}>
      <ChatPanel fmt={{ locale, calendar, tz }} />
    </Shell>
  );
}
