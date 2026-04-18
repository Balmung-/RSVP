import { prisma } from "./db";
import { getEmailProvider } from "./providers";
import { logAction } from "./audit";

// Once-a-day digest for admins. Summary of:
//   - live send failures per campaign
//   - new unsubscribes in the last 24h
//   - pending send approvals
//   - inbox items still needing review
//
// Fired from /api/cron/tick. Idempotency is via a digest.sent eventLog
// row with the local date — the tick handler is called every minute, so
// we bail fast on every call except the first one of the day after the
// configured hour.

const TZ = () => process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const BRAND = () => process.env.APP_BRAND ?? "Einai";
const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";

function enabled(): boolean {
  const v = (process.env.DELIVERABILITY_DIGEST ?? "").toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

function digestHour(): number {
  const raw = Number(process.env.DIGEST_HOUR ?? 7);
  return Number.isFinite(raw) && raw >= 0 && raw < 24 ? Math.floor(raw) : 7;
}

// Local-time YYYY-MM-DD for the app's configured timezone. Uses Intl so
// Riyadh / Dubai / UTC all resolve without a moment.js dependency.
function localDateKey(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const dd = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${dd}`;
}

function localHour(d: Date = new Date()): number {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ(),
    hour: "2-digit",
    hour12: false,
  }).format(d);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export type DigestOutcome =
  | { sent: false; reason: "disabled" | "too_early" | "already_sent" | "no_admins" }
  | { sent: true; recipients: number; dateKey: string };

export async function maybeSendDailyDigest(now: Date = new Date()): Promise<DigestOutcome> {
  if (!enabled()) return { sent: false as const, reason: "disabled" };
  if (localHour(now) < digestHour()) return { sent: false as const, reason: "too_early" };
  const dateKey = localDateKey(now);
  const already = await prisma.eventLog.findFirst({
    where: { kind: "digest.sent", data: { contains: dateKey } },
    select: { id: true },
  });
  if (already) return { sent: false as const, reason: "already_sent" };

  const admins = await prisma.user.findMany({
    where: { role: "admin", active: true, email: { not: "" } },
    select: { email: true, fullName: true },
  });
  if (admins.length === 0) return { sent: false as const, reason: "no_admins" };

  const summary = await buildSummary(now);
  const { subject, text, html } = renderDigest(summary, dateKey);

  const provider = getEmailProvider();
  await Promise.all(
    admins.map((a) =>
      provider
        .send({ to: a.email, subject, html, text })
        .catch((e) => {
          // eslint-disable-next-line no-console
          console.error("[digest] send failed", a.email, String(e).slice(0, 200));
        }),
    ),
  );

  await logAction({
    kind: "digest.sent",
    refType: "digest",
    data: { dateKey, recipients: admins.length, ...summary.totals },
    actorId: null,
  });

  return { sent: true as const, recipients: admins.length, dateKey };
}

// ---- summary gathering ----

type CampaignFailureRow = {
  id: string;
  name: string;
  email: number;
  sms: number;
};

async function buildSummary(now: Date) {
  const since24h = new Date(now.getTime() - 24 * 3600_000);
  const failureLookbackSince = new Date(now.getTime() - 60 * 24 * 3600_000);

  const [failures, newUnsubs, pendingApprovals, inboxToReview, activeCampaignCount] =
    await Promise.all([
      prisma.invitation.findMany({
        where: {
          status: { in: ["failed", "bounced"] },
          createdAt: { gte: failureLookbackSince },
        },
        select: { inviteeId: true, channel: true, createdAt: true, campaignId: true },
      }),
      prisma.unsubscribe.count({ where: { createdAt: { gte: since24h } } }),
      prisma.sendApproval.count({ where: { status: "pending" } }),
      prisma.inboundMessage.count({ where: { status: "needs_review" } }),
      prisma.campaign.count({ where: { status: { in: ["draft", "active", "sending"] } } }),
    ]);

  // Filter out failures that later succeeded on the same (invitee, channel).
  let liveEmail = 0;
  let liveSms = 0;
  const perCampaign = new Map<string, { email: number; sms: number }>();
  if (failures.length > 0) {
    const later = await prisma.invitation.groupBy({
      by: ["inviteeId", "channel"],
      where: {
        inviteeId: { in: failures.map((f) => f.inviteeId) },
        status: { in: ["sent", "delivered"] },
      },
      _max: { createdAt: true },
    });
    const okAt = new Map<string, Date>();
    for (const g of later) {
      if (g._max.createdAt) okAt.set(`${g.inviteeId}:${g.channel}`, g._max.createdAt);
    }
    for (const f of failures) {
      const ok = okAt.get(`${f.inviteeId}:${f.channel}`);
      if (ok && ok >= f.createdAt) continue;
      const slot = perCampaign.get(f.campaignId) ?? { email: 0, sms: 0 };
      if (f.channel === "email") {
        slot.email++;
        liveEmail++;
      } else if (f.channel === "sms") {
        slot.sms++;
        liveSms++;
      }
      perCampaign.set(f.campaignId, slot);
    }
  }

  let topCampaigns: CampaignFailureRow[] = [];
  if (perCampaign.size > 0) {
    const campaigns = await prisma.campaign.findMany({
      where: { id: { in: Array.from(perCampaign.keys()) } },
      select: { id: true, name: true },
    });
    topCampaigns = campaigns
      .map((c) => {
        const s = perCampaign.get(c.id) ?? { email: 0, sms: 0 };
        return { id: c.id, name: c.name, email: s.email, sms: s.sms };
      })
      .sort((a, b) => b.email + b.sms - (a.email + a.sms))
      .slice(0, 5);
  }

  return {
    topCampaigns,
    totals: {
      liveEmail,
      liveSms,
      liveTotal: liveEmail + liveSms,
      newUnsubs,
      pendingApprovals,
      inboxToReview,
      activeCampaignCount,
    },
  };
}

// ---- rendering ----

function renderDigest(
  summary: Awaited<ReturnType<typeof buildSummary>>,
  dateKey: string,
): { subject: string; text: string; html: string } {
  const brand = BRAND();
  const url = APP_URL().replace(/\/$/, "");

  const lines: string[] = [];
  lines.push(`${brand} · Daily deliverability digest · ${dateKey}`);
  lines.push("");
  lines.push(`Active campaigns: ${summary.totals.activeCampaignCount.toLocaleString()}`);
  lines.push(
    `Live send failures: ${summary.totals.liveTotal.toLocaleString()}` +
      (summary.totals.liveTotal > 0
        ? ` (${summary.totals.liveEmail} email · ${summary.totals.liveSms} SMS)`
        : ""),
  );
  lines.push(`New unsubscribes (24h): ${summary.totals.newUnsubs.toLocaleString()}`);
  lines.push(`Pending approvals: ${summary.totals.pendingApprovals.toLocaleString()}`);
  lines.push(`Inbox items to review: ${summary.totals.inboxToReview.toLocaleString()}`);

  if (summary.topCampaigns.length > 0) {
    lines.push("");
    lines.push("Campaigns with live failures:");
    for (const c of summary.topCampaigns) {
      lines.push(
        `  · ${c.name} — ${c.email + c.sms} failing (${c.email} email · ${c.sms} SMS)`,
      );
      lines.push(`    ${url}/deliverability?campaign=${c.id}`);
    }
  }
  lines.push("");
  lines.push(`Open Deliverability: ${url}/deliverability`);
  lines.push("");
  lines.push(`— ${brand}`);

  const text = lines.join("\n");

  const rows = [
    row("Active campaigns", summary.totals.activeCampaignCount),
    row("Live send failures", summary.totals.liveTotal, summary.totals.liveTotal > 0 ? "fail" : undefined),
    row("New unsubscribes (24h)", summary.totals.newUnsubs),
    row("Pending approvals", summary.totals.pendingApprovals, summary.totals.pendingApprovals > 0 ? "warn" : undefined),
    row("Inbox to review", summary.totals.inboxToReview, summary.totals.inboxToReview > 0 ? "warn" : undefined),
  ].join("");

  const campaignBlock = summary.topCampaigns.length === 0
    ? ""
    : `<tr><td colspan="2" style="padding:18px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8e8e8a">Campaigns with live failures</td></tr>` +
      summary.topCampaigns
        .map(
          (c) => `<tr><td style="padding:6px 0 6px">
            <a href="${escape(`${url}/deliverability?campaign=${c.id}`)}" style="color:#141414;text-decoration:none">${escape(c.name)}</a>
          </td><td style="padding:6px 0 6px;text-align:right;font-variant-numeric:tabular-nums;color:#8e8e8a">${c.email + c.sms} · ${c.email}e · ${c.sms}s</td></tr>`,
        )
        .join("");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#141414;line-height:1.55">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;padding:28px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 28px rgba(0,0,0,.06)">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8e8e8a;margin-bottom:6px">${escape(brand)} · daily digest</div>
    <div style="font-size:22px;font-weight:500;letter-spacing:-.01em;margin-bottom:18px">${escape(dateKey)}</div>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
      ${rows}
      ${campaignBlock}
    </table>
    <div style="margin-top:22px"><a href="${escape(`${url}/deliverability`)}" style="display:inline-block;padding:10px 16px;background:#0a0a0a;color:#ffffff;border-radius:9999px;text-decoration:none;font-size:14px">Open Deliverability</a></div>
  </div>
</body></html>`;

  const subject = summary.totals.liveTotal > 0
    ? `[${brand}] Digest · ${summary.totals.liveTotal} failing · ${dateKey}`
    : `[${brand}] Digest · all clear · ${dateKey}`;

  return { subject, text, html };
}

function row(label: string, value: number, tone?: "warn" | "fail"): string {
  const color = tone === "fail" ? "#c14a3a" : tone === "warn" ? "#b58100" : "#141414";
  return `<tr>
    <td style="padding:8px 0;border-bottom:1px solid #f1f1ef;color:#4a4a46">${escape(label)}</td>
    <td style="padding:8px 0;border-bottom:1px solid #f1f1ef;text-align:right;font-variant-numeric:tabular-nums;font-weight:500;color:${color}">${value.toLocaleString()}</td>
  </tr>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
