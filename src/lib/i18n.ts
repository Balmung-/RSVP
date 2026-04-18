// Two-locale dictionary. Keep keys terse — they're force-bearing.

export type Locale = "en" | "ar";

export const dict = {
  en: {
    dir: "ltr",
    rsvp: {
      title: "You're invited",
      hello: "Dear",
      youAreInvited: "You are cordially invited.",
      willAttend: "I will attend",
      wontAttend: "I cannot attend",
      guests: "Guests accompanying me",
      message: "A short message (optional)",
      submit: "Submit response",
      thankYou: "Thank you",
      received: "Your response has been recorded.",
      closed: "RSVP is closed.",
      deadline: "Please reply by",
      at: "at",
      alreadyResponded: "You have already responded.",
      update: "Update response",
      pickDate: "Please pick a date before submitting.",
      reviewErrors: "Please fix the highlighted fields.",
      privacy: "Your response is stored by {{brand}} for the event's protocol records.",
    },
    email: {
      defaultSubject: "Invitation — {{campaign}}",
      body:
        "Dear {{name}},\n\n" +
        "You are cordially invited to {{campaign}}{{#venue}} at {{venue}}{{/venue}}{{#eventAt}} on {{eventAt}}{{/eventAt}}.\n\n" +
        "Kindly confirm your attendance: {{rsvpUrl}}\n\n" +
        "Regards,\n{{brand}}",
    },
    sms: {
      body:
        "{{brand}}: You are invited to {{campaign}}. RSVP: {{rsvpUrl}}",
    },
  },
  ar: {
    dir: "rtl",
    rsvp: {
      title: "دعوتكم",
      hello: "السادة/",
      youAreInvited: "يسعدنا دعوتكم.",
      willAttend: "سأحضر",
      wontAttend: "أعتذر عن الحضور",
      guests: "عدد المرافقين",
      message: "رسالة قصيرة (اختياري)",
      submit: "إرسال الرد",
      thankYou: "شكراً لكم",
      received: "تم تسجيل ردكم.",
      closed: "انتهت فترة تأكيد الحضور.",
      deadline: "نرجو الرد قبل",
      at: "في",
      alreadyResponded: "تم استلام ردكم مسبقاً.",
      update: "تعديل الرد",
      pickDate: "يرجى اختيار التاريخ قبل الإرسال.",
      reviewErrors: "يرجى مراجعة الحقول المطلوبة.",
      privacy: "يتم حفظ ردكم لدى {{brand}} لأغراض التنظيم البروتوكولي للفعالية.",
    },
    email: {
      defaultSubject: "دعوة — {{campaign}}",
      body:
        "السادة/ {{name}}،\n\n" +
        "يسرّنا دعوتكم لحضور {{campaign}}{{#venue}} في {{venue}}{{/venue}}{{#eventAt}} بتاريخ {{eventAt}}{{/eventAt}}.\n\n" +
        "يرجى تأكيد الحضور عبر الرابط: {{rsvpUrl}}\n\n" +
        "مع التحية،\n{{brand}}",
    },
    sms: {
      body: "{{brand}}: دعوتكم لحضور {{campaign}}. للتأكيد: {{rsvpUrl}}",
    },
  },
} as const;

export function t(locale: Locale) {
  return dict[locale] ?? dict.en;
}
