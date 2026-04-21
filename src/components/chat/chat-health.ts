export type ChatHealthSnapshot = {
  ok: boolean;
  db: "up" | "down";
  ai: {
    name: "anthropic" | "openrouter" | "unknown";
    configured: boolean;
    reason?:
      | "anthropic_not_configured"
      | "openrouter_not_configured"
      | "unknown_runtime";
  };
};

export type ChatSystemNotice = {
  tone: "warning" | "danger";
  title: string;
  detail: string;
  allowRefreshStatus: boolean;
};

type Locale = "en" | "ar";

export function parseChatHealth(payload: unknown): ChatHealthSnapshot | null {
  if (!isObject(payload)) return null;
  if (payload.db !== "up" && payload.db !== "down") return null;
  if (!isObject(payload.ai)) return null;
  if (
    payload.ai.name !== "anthropic" &&
    payload.ai.name !== "openrouter" &&
    payload.ai.name !== "unknown"
  ) {
    return null;
  }
  if (typeof payload.ai.configured !== "boolean") return null;
  const reason = payload.ai.reason;
  if (
    reason !== undefined &&
    reason !== "anthropic_not_configured" &&
    reason !== "openrouter_not_configured" &&
    reason !== "unknown_runtime"
  ) {
    return null;
  }
  return {
    ok: payload.ok === true,
    db: payload.db,
    ai: {
      name: payload.ai.name,
      configured: payload.ai.configured,
      reason,
    },
  };
}

export function shouldRefreshHealthForError(error: string | null): boolean {
  if (!error) return false;
  return (
    error === "anthropic_not_configured" ||
    error === "openrouter_not_configured" ||
    error === "unknown_runtime" ||
    error === "HTTP 503"
  );
}

export function deriveChatSystemNotice({
  locale,
  topError,
  health,
}: {
  locale: Locale;
  topError: string | null;
  health: ChatHealthSnapshot | null;
}): ChatSystemNotice | null {
  if (health?.db === "down") {
    return locale === "ar"
      ? {
          tone: "danger",
          title: "قاعدة البيانات غير متاحة",
          detail: "لا يمكن للمحادثة الإرسال أو التحديث حتى تعود قاعدة البيانات.",
          allowRefreshStatus: true,
        }
      : {
          tone: "danger",
          title: "Database unavailable",
          detail: "Chat cannot send or refresh until the database recovers.",
          allowRefreshStatus: true,
        };
  }

  if (
    health?.ai.configured &&
    (topError === "anthropic_not_configured" ||
      topError === "openrouter_not_configured" ||
      topError === "unknown_runtime")
  ) {
    return null;
  }

  const runtimeReason = runtimeReasonFrom(topError, health);
  if (runtimeReason) {
    return formatRuntimeNotice(locale, runtimeReason);
  }

  if (topError === "rate_limited") {
    return locale === "ar"
      ? {
          tone: "warning",
          title: "تم الوصول إلى حد الإرسال المؤقت",
          detail: "انتظر لحظة ثم أعد المحاولة.",
          allowRefreshStatus: false,
        }
      : {
          tone: "warning",
          title: "Rate limited",
          detail: "Wait a moment, then try again.",
          allowRefreshStatus: false,
        };
  }

  if (topError === "session_not_found") {
    return locale === "ar"
      ? {
          tone: "warning",
          title: "جلسة المحادثة غير متاحة",
          detail: "ابدأ مساحة عمل جديدة أو اختر جلسة حديثة من القائمة.",
          allowRefreshStatus: false,
        }
      : {
          tone: "warning",
          title: "Workspace session unavailable",
          detail: "Start a new workspace or pick a recent session.",
          allowRefreshStatus: false,
        };
  }

  if (!topError) return null;

  return locale === "ar"
    ? {
        tone: "danger",
        title: "تعذر إكمال الطلب",
        detail: topError,
        allowRefreshStatus: false,
      }
    : {
        tone: "danger",
        title: "Request failed",
        detail: topError,
        allowRefreshStatus: false,
      };
}

function runtimeReasonFrom(
  topError: string | null,
  health: ChatHealthSnapshot | null,
):
  | "anthropic_not_configured"
  | "openrouter_not_configured"
  | "unknown_runtime"
  | null {
  if (health && !health.ai.configured) {
    return health.ai.reason ?? "unknown_runtime";
  }
  if (
    topError === "anthropic_not_configured" ||
    topError === "openrouter_not_configured" ||
    topError === "unknown_runtime"
  ) {
    return health ? null : topError;
  }
  return null;
}

function formatRuntimeNotice(
  locale: Locale,
  reason: "anthropic_not_configured" | "openrouter_not_configured" | "unknown_runtime",
): ChatSystemNotice {
  if (locale === "ar") {
    if (reason === "anthropic_not_configured") {
      return {
        tone: "warning",
        title: "خدمة الذكاء غير مهيأة",
        detail: "المزود الحالي هو Anthropic لكنه غير مهيأ على الخادم بعد.",
        allowRefreshStatus: true,
      };
    }
    if (reason === "openrouter_not_configured") {
      return {
        tone: "warning",
        title: "خدمة الذكاء غير مهيأة",
        detail: "المزود الحالي هو OpenRouter لكنه غير مهيأ على الخادم بعد.",
        allowRefreshStatus: true,
      };
    }
    return {
      tone: "warning",
      title: "إعداد مزود الذكاء غير معروف",
      detail: "قيمة مزود الذكاء على الخادم غير معروفة. تحقق من الإعدادات ثم أعد المحاولة.",
      allowRefreshStatus: true,
    };
  }

  if (reason === "anthropic_not_configured") {
    return {
      tone: "warning",
      title: "AI backend unavailable",
      detail: "Anthropic is selected, but the server is not fully configured yet.",
      allowRefreshStatus: true,
    };
  }
  if (reason === "openrouter_not_configured") {
    return {
      tone: "warning",
      title: "AI backend unavailable",
      detail: "OpenRouter is selected, but the server is not fully configured yet.",
      allowRefreshStatus: true,
    };
  }
  return {
    tone: "warning",
    title: "AI runtime is misconfigured",
    detail: "The server is set to an unknown AI backend. Check deployment config, then try again.",
    allowRefreshStatus: true,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
