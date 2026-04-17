import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Customize moved into the Content tab of the campaign workspace —
// this route just redirects so any stale links keep working.
export default function CustomizeRedirect({ params }: { params: { id: string } }) {
  redirect(`/campaigns/${params.id}?tab=content`);
}
