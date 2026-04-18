import { cookies } from "next/headers";

// Admin locale + calendar preferences, stored in cookies. No DB migration.
// The dict below is the single source for every translated admin string;
// keep keys terse and commit to English/Arabic pairs.

export type AdminLocale = "en" | "ar";
export type AdminCalendar = "gregorian" | "hijri";

const COOKIE_LOCALE = "einai_admin_locale";
const COOKIE_CAL = "einai_admin_cal";

export function readAdminLocale(): AdminLocale {
  return cookies().get(COOKIE_LOCALE)?.value === "ar" ? "ar" : "en";
}

export function writeAdminLocale(locale: AdminLocale) {
  cookies().set(COOKIE_LOCALE, locale, {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export function readAdminCalendar(): AdminCalendar {
  return cookies().get(COOKIE_CAL)?.value === "hijri" ? "hijri" : "gregorian";
}

export function writeAdminCalendar(cal: AdminCalendar) {
  cookies().set(COOKIE_CAL, cal, {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export const adminT = {
  en: {
    // Nav
    overview: "Overview",
    campaigns: "Campaigns",
    contacts: "Contacts",
    templates: "Templates",
    inbox: "Inbox",
    approvals: "Approvals",
    teams: "Teams",
    people: "People",
    events: "Events",
    settings: "Settings",
    // Auth
    signOut: "Sign out",
    signIn: "Sign in",
    // Generic actions
    new: "New",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    archive: "Archive",
    unarchive: "Unarchive",
    edit: "Edit",
    create: "Create",
    remove: "Remove",
    close: "Close",
    confirm: "Confirm",
    search: "Search",
    filter: "Filter",
    load: "Load",
    send: "Send",
    // Campaign
    newCampaign: "New campaign",
    newContact: "New contact",
    newTemplate: "New template",
    sendInvitations: "Send invitations",
    sendingEllipsis: "Sending…",
    // Status
    draft: "Draft",
    active: "Active",
    sending: "Sending",
    closed: "Closed",
    archived: "Archived",
    // Stats
    invited: "Invited",
    responded: "Responded",
    attending: "Attending",
    declined: "Declined",
    pending: "Pending",
    headcount: "Headcount",
    guestsPlus: "Guests +",
    // Settings
    signedInAs: "Signed in as",
    role: "Role",
    language: "Language",
    calendar: "Calendar",
    gregorian: "Gregorian",
    hijri: "Hijri (Umm al-Qura)",
    english: "English",
    arabic: "العربية",
    changePassword: "Change password",
    twoStep: "Two-step sign-in",
    managePeople: "Manage people",
    integrations: "Integrations",
    account: "Account",
    // Empties
    noCampaignsYet: "No campaigns yet",
    // Dashboard
    thisWeek: "This week",
    activity: "Activity",
    responsePulse: "Response pulse",
    needsAttention: "Needs attention",
    vipWatch: "VIP watch",
    activeCampaigns: "Active campaigns",
    sendingNow: "Sending now",
    responsesThisWeek: "Responses this week",
    deliveryFailures7d: "Delivery failures (7d)",
    deliverability: "Deliverability",
  },
  ar: {
    overview: "نظرة عامة",
    campaigns: "الحملات",
    contacts: "جهات الاتصال",
    templates: "القوالب",
    inbox: "صندوق الوارد",
    approvals: "الموافقات",
    teams: "الفرق",
    people: "الفريق",
    events: "السجل",
    settings: "الإعدادات",
    signOut: "تسجيل خروج",
    signIn: "تسجيل الدخول",
    new: "جديد",
    save: "حفظ",
    cancel: "إلغاء",
    delete: "حذف",
    archive: "أرشفة",
    unarchive: "إعادة من الأرشيف",
    edit: "تعديل",
    create: "إنشاء",
    remove: "إزالة",
    close: "إغلاق",
    confirm: "تأكيد",
    search: "بحث",
    filter: "تصفية",
    load: "تحميل",
    send: "إرسال",
    newCampaign: "حملة جديدة",
    newContact: "جهة اتصال جديدة",
    newTemplate: "قالب جديد",
    sendInvitations: "إرسال الدعوات",
    sendingEllipsis: "جاري الإرسال…",
    draft: "مسودة",
    active: "فعّال",
    sending: "جاري الإرسال",
    closed: "مغلقة",
    archived: "مؤرشفة",
    invited: "المدعوون",
    responded: "الردود",
    attending: "سيحضرون",
    declined: "معتذرون",
    pending: "بالانتظار",
    headcount: "الحضور المتوقع",
    guestsPlus: "المرافقون +",
    signedInAs: "تسجيل الدخول باسم",
    role: "الدور",
    language: "اللغة",
    calendar: "التقويم",
    gregorian: "ميلادي",
    hijri: "هجري (أم القرى)",
    english: "English",
    arabic: "العربية",
    changePassword: "تغيير كلمة المرور",
    twoStep: "تحقق من خطوتين",
    managePeople: "إدارة الفريق",
    integrations: "الخدمات الخارجية",
    account: "الحساب",
    noCampaignsYet: "لا توجد حملات بعد",
    thisWeek: "هذا الأسبوع",
    activity: "النشاط",
    responsePulse: "نبض الردود",
    needsAttention: "بحاجة إلى متابعة",
    vipWatch: "كبار الشخصيات",
    activeCampaigns: "الحملات الفعّالة",
    sendingNow: "جاري الإرسال الآن",
    responsesThisWeek: "ردود هذا الأسبوع",
    deliveryFailures7d: "فشل الإرسال (٧ أيام)",
    deliverability: "قابلية الإرسال",
  },
} as const;

export type AdminT = typeof adminT.en;

export function adminDict(locale: AdminLocale): AdminT {
  return adminT[locale];
}

// Date formatting that respects the user's locale + calendar preference.
// Gregorian = en-GB / ar-SA with default calendar; Hijri = Umm al-Qura.
// Returns plain strings so callers just substitute their existing
// Intl.DateTimeFormat usage one-for-one.
export function formatAdminDate(
  d: Date | null | undefined,
  locale: AdminLocale,
  calendar: AdminCalendar,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  if (!d) return "";
  const base = locale === "ar" ? "ar-SA" : "en-GB";
  const tag = calendar === "hijri"
    ? `${base}-u-ca-islamic-umalqura`
    : base;
  try {
    return new Intl.DateTimeFormat(tag, {
      ...opts,
      timeZone: process.env.APP_TIMEZONE ?? "Asia/Riyadh",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-GB", opts).format(d);
  }
}
