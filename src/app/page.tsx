import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  redirect("/chat");
}
