import { cookies } from "next/headers";

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
    signOut: "Sign out",
    signIn: "Sign in",
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
    newCampaign: "New campaign",
    newContact: "New contact",
    newTemplate: "New template",
    sendInvitations: "Send invitations",
    sendingEllipsis: "Sending...",
    draft: "Draft",
    active: "Active",
    sending: "Sending",
    closed: "Closed",
    archived: "Archived",
    invited: "Invited",
    responded: "Responded",
    attending: "Attending",
    declined: "Declined",
    pending: "Pending",
    headcount: "Headcount",
    guestsPlus: "Guests +",
    signedInAs: "Signed in as",
    role: "Role",
    language: "Language",
    calendar: "Calendar",
    gregorian: "Gregorian",
    hijri: "Hijri (Umm al-Qura)",
    english: "English",
    arabic: "Arabic (Saudi)",
    changePassword: "Change password",
    twoStep: "Two-step sign-in",
    managePeople: "Manage people",
    integrations: "Integrations",
    account: "Account",
    noCampaignsYet: "No campaigns yet",
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
    people: "الأشخاص",
    events: "السجل",
    settings: "الإعدادات",
    signOut: "تسجيل الخروج",
    signIn: "تسجيل الدخول",
    new: "جديد",
    save: "حفظ",
    cancel: "إلغاء",
    delete: "حذف",
    archive: "أرشفة",
    unarchive: "إلغاء الأرشفة",
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
    sendingEllipsis: "جارٍ الإرسال...",
    draft: "مسودة",
    active: "نشطة",
    sending: "قيد الإرسال",
    closed: "مغلقة",
    archived: "مؤرشفة",
    invited: "المدعوون",
    responded: "الردود",
    attending: "سيحضرون",
    declined: "معتذرون",
    pending: "بالانتظار",
    headcount: "عدد الحضور",
    guestsPlus: "المرافقون +",
    signedInAs: "تسجيل الدخول باسم",
    role: "الدور",
    language: "اللغة",
    calendar: "التقويم",
    gregorian: "ميلادي",
    hijri: "هجري (أم القرى)",
    english: "English",
    arabic: "العربية (السعودية)",
    changePassword: "تغيير كلمة المرور",
    twoStep: "التحقق بخطوتين",
    managePeople: "إدارة الأشخاص",
    integrations: "التكاملات",
    account: "الحساب",
    noCampaignsYet: "لا توجد حملات بعد",
    thisWeek: "هذا الأسبوع",
    activity: "النشاط",
    responsePulse: "نبض الردود",
    needsAttention: "تحتاج متابعة",
    vipWatch: "مراقبة كبار الشخصيات",
    activeCampaigns: "الحملات النشطة",
    sendingNow: "يتم الإرسال الآن",
    responsesThisWeek: "ردود هذا الأسبوع",
    deliveryFailures7d: "تعثرات الإرسال (7 أيام)",
    deliverability: "قابلية الإرسال",
  },
} as const;

export type AdminT = typeof adminT.en;

export function adminDict(locale: AdminLocale): AdminT {
  return adminT[locale] as unknown as AdminT;
}

export function formatAdminDate(
  d: Date | null | undefined,
  locale: AdminLocale,
  calendar: AdminCalendar,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  if (!d) return "";
  const base = locale === "ar" ? "ar-SA" : "en-GB";
  const tag = calendar === "hijri" ? `${base}-u-ca-islamic-umalqura` : base;
  try {
    return new Intl.DateTimeFormat(tag, {
      ...opts,
      timeZone: process.env.APP_TIMEZONE ?? "Asia/Riyadh",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-GB", opts).format(d);
  }
}
