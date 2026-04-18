import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { getCurrentUser } from "@/lib/auth";
import { readAdminLocale, readAdminCalendar } from "@/lib/adminLocale";

// Standalone chat page. Push 8 will surface the same panel from the
// avatar menu + a ⌘J global shortcut; this page is the honest
// smoke-test route for now — log in, visit /chat, send a message,
// see streaming text + directives.
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
