import { prisma } from "./db";
import { getEmailProvider } from "./providers";

// Office-facing notifications. Fire-and-forget: we don't want a webhook
// push or a stage failure's recovery path to be held up by an outbound
// email. Every call is wrapped so an email failure never surfaces as a
// business error.

type NotifyKind =
  | "stage.failed"
  | "approval.requested"
  | "rsvp.high_value"
  | "webhook.inbound_review";

const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";
const BRAND = () => process.env.APP_BRAND ?? "Einai";

export async function notifyAdmins(
  kind: NotifyKind,
  subject: string,
  body: string,
  linkHref?: string,
) {
  try {
    const admins = await prisma.user.findMany({
      where: { role: "admin", active: true, email: { not: "" } },
      select: { email: true, fullName: true },
    });
    if (admins.length === 0) return;
    const provider = getEmailProvider();
    const fullLink = linkHref ? `${APP_URL().replace(/\/$/, "")}${linkHref}` : null;

    const text = [
      body.trim(),
      fullLink ? `\nOpen: ${fullLink}` : null,
      `\n— ${BRAND()}`,
    ]
      .filter(Boolean)
      .join("\n");

    const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#141414;line-height:1.55">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;padding:28px 28px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 8px 28px rgba(0,0,0,0.06)">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8e8e8a;margin-bottom:6px">${escape(kind)}</div>
    <div style="font-size:14px;line-height:20px;white-space:pre-wrap;color:#141414">${escape(body)}</div>
    ${
      fullLink
        ? `<div style="margin-top:20px"><a href="${escape(fullLink)}" style="display:inline-block;padding:10px 16px;background:#0a0a0a;color:#ffffff;border-radius:9999px;text-decoration:none;font-size:14px">Open in ${escape(BRAND())}</a></div>`
        : ""
    }
  </div>
</body></html>`;

    // Don't await each send — fire in parallel, catch individually.
    await Promise.all(
      admins.map((a) =>
        provider
          .send({ to: a.email, subject: `[${BRAND()}] ${subject}`, html, text })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[notify] admin send failed", a.email, String(err).slice(0, 200));
          }),
      ),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[notify] notifyAdmins failed", String(err).slice(0, 200));
  }
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
