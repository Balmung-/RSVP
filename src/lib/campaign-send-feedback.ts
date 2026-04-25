export type DispatchChannel = "email" | "sms" | "whatsapp";

export type DispatchFailureReason = {
  channel: DispatchChannel;
  error: string;
  count: number;
};

export type DispatchTally = {
  email: number;
  sms: number;
  whatsapp: number;
  skipped: number;
  failed: number;
  failureReasons: DispatchFailureReason[];
};

export function summarizeFailureReasons(
  reasons: DispatchFailureReason[],
  limit = 3,
): string | null {
  const top = reasons
    .slice()
    .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel))
    .slice(0, limit);
  if (top.length === 0) return null;
  return top
    .map((reason) => `${reason.count} ${channelLabel(reason.channel)}: ${reason.error}`)
    .join(" | ");
}

export function buildDispatchFlash(args: {
  kind: "send" | "retry";
  result: DispatchTally;
}): { kind: "success" | "warn"; text: string; detail?: string } {
  const { kind, result } = args;
  const sent = result.email + result.sms + result.whatsapp;
  const verb = kind === "send" ? "Send" : "Retry";
  const tone = result.failed > 0 ? "warn" : "success";
  const parts = [
    `${sent} sent`,
    result.failed > 0 ? `${result.failed} failed` : null,
    result.skipped > 0 ? `${result.skipped} skipped` : null,
  ].filter((part): part is string => part !== null);
  const detail = summarizeFailureReasons(result.failureReasons);
  return {
    kind: tone,
    text: `${verb} finished - ${parts.join(", ")}.`,
    detail: detail
      ? `Top failures: ${detail}. Open Deliverability or Activity log for per-invitee details.`
      : undefined,
  };
}

function channelLabel(channel: DispatchChannel) {
  switch (channel) {
    case "email":
      return "email";
    case "sms":
      return "SMS";
    case "whatsapp":
      return "WhatsApp";
  }
}
