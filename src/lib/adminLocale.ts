import { cookies } from "next/headers";

// Admin locale stored in a cookie. Cheap and works across requests;
// no DB migration needed. Users toggle via Settings.

export type AdminLocale = "en" | "ar";
const COOKIE = "einai_admin_locale";

export function readAdminLocale(): AdminLocale {
  const c = cookies().get(COOKIE)?.value;
  return c === "ar" ? "ar" : "en";
}

export function writeAdminLocale(locale: AdminLocale) {
  cookies().set(COOKIE, locale, {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export const adminT = {
  en: {
    overview: "Overview",
    campaigns: "Campaigns",
    contacts: "Contacts",
    inbox: "Inbox",
    teams: "Teams",
    people: "People",
    events: "Events",
    settings: "Settings",
    signOut: "Sign out",
    newCampaign: "New campaign",
    newContact: "New contact",
    signedInAs: "Signed in as",
    language: "Language",
    english: "English",
    arabic: "العربية",
  },
  ar: {
    overview: "نظرة عامة",
    campaigns: "الحملات",
    contacts: "جهات الاتصال",
    inbox: "صندوق الوارد",
    teams: "الفرق",
    people: "الفريق",
    events: "السجل",
    settings: "الإعدادات",
    signOut: "تسجيل خروج",
    newCampaign: "حملة جديدة",
    newContact: "جهة اتصال جديدة",
    signedInAs: "تسجيل الدخول باسم",
    language: "اللغة",
    english: "English",
    arabic: "العربية",
  },
} as const;

export type AdminT = typeof adminT.en;

export function adminDict(locale: AdminLocale): AdminT {
  return adminT[locale];
}
