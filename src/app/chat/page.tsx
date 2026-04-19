import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ChatWorkspace } from "@/components/chat/ChatWorkspace";
import { getCurrentUser } from "@/lib/auth";
import { readAdminLocale, readAdminCalendar } from "@/lib/adminLocale";

// Standalone chat page — the primary entry point to the AI
// assistant. Surfaced from three places as of Push 8:
//   - AvatarMenu "Chat" link (top of the dropdown, featured)
//   - CommandPalette "Chat" item (search `/` or `⌘K`, type "chat")
//   - Global `⌘J` / `Ctrl+J` shortcut (direct navigation)
//
// W2 pivot: the page now renders a split workspace (ChatWorkspace
// client component) rather than the old single-column ChatPanel.
// The split puts the transcript + composer on the left (ChatRail)
// and a persistent widget dashboard on the right (WorkspaceDashboard).
// `compactTitle` shrinks the title block from the normal pt-10/pb-6
// section header to pt-6/pb-2 so the workspace has the vertical
// budget the split needs — on a 900px-tall laptop, every 8rem
// counts.
//
// The page stays a server component: it reads the admin locale /
// calendar cookies plus APP_TIMEZONE on the server and threads them
// down as props. `formatAdminDate` can't run on the client (it reads
// cookies via next/headers), so directives get their own
// client-friendly formatter that takes the same inputs explicitly.

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();
  const tz = process.env.APP_TIMEZONE ?? "Asia/Riyadh";

  return (
    <Shell title={locale === "ar" ? "المحادثة" : "Chat"} compactTitle>
      <ChatWorkspace fmt={{ locale, calendar, tz }} />
    </Shell>
  );
}
