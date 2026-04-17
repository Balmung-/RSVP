import type { Metadata } from "next";
import "./globals.css";
import { readAdminLocale } from "@/lib/adminLocale";

export const metadata: Metadata = {
  title: "Einai — Protocol",
  description: "Invitations and RSVP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = readAdminLocale();
  const dir = locale === "ar" ? "rtl" : "ltr";
  return (
    <html lang={locale} dir={dir}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
