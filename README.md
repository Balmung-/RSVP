# Einai RSVP

Invitation and RSVP platform. Email + SMS. Long-running campaigns, deduplication, response tracking. EN/AR with RTL. Provider-agnostic — drop in keys when you have them.

## Local

```bash
docker compose up -d                # postgres on :5432
npm install
cp .env.example .env.local
npm run db:push
npm run db:seed
npm run dev
```

Open <http://localhost:3000>. Default password: `admin`.

Stub mode logs outgoing messages to the server console — the full send/track/RSVP flow works without any external credentials.

## Deployment — recommended stack

**App → Vercel. DB → Neon.** One commit, two managed services, zero glue code.

> For steady-state ops (post-deploy verification, secret rotation, staging/prod parity, rollback, failure recovery), see [OPERATIONS.md](./OPERATIONS.md).

### 1. Postgres on Neon

1. [neon.tech](https://neon.tech) → **Create project** → region `AWS eu-central-1` (closest to KSA with broad coverage; use `AWS me-south-1` / `aws-bahrain` once Neon exposes it).
2. Copy the **pooled** connection string (ends `-pooler`) for `DATABASE_URL`.
3. Point your local `DATABASE_URL` at it and run once: `npm run db:push`.

### 2. App on Vercel

1. Import the GitHub repo at <https://vercel.com/new>.
2. Framework: Next.js (auto-detected). Region: `fra1` (set in `vercel.json`).
3. Environment variables — paste from `.env.example`:
   - `DATABASE_URL` — Neon pooled URL.
   - `APP_URL` — your Vercel URL (e.g. `https://einai.vercel.app`).
   - `APP_BRAND`, `ADMIN_PASSWORD`, `SESSION_SECRET` (32+ bytes random).
   - `EMAIL_PROVIDER`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, provider key.
   - `SMS_PROVIDER`, `SMS_SENDER_ID`, provider credentials.
4. Deploy. `prisma generate` runs on every build via `vercel.json`.

### 3. Switch a provider on

Everything runs in `stub` mode by default. Flip one env var, redeploy:

| Channel  | `EMAIL_PROVIDER` / `SMS_PROVIDER` / `WHATSAPP_PROVIDER` | Required env                                                |
| -------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Email    | `sendgrid`                                              | `SENDGRID_API_KEY`                                          |
| Email    | `resend`                                                | `RESEND_API_KEY`                                            |
| SMS      | `twilio`                                                | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`    |
| SMS      | `unifonic` (SA)                                         | `UNIFONIC_APP_SID`, `UNIFONIC_SENDER_NAME`                  |
| SMS      | `msegat` (SA)                                           | `MSEGAT_API_KEY`, `MSEGAT_USERNAME`, `SMS_SENDER_ID`        |
| SMS      | `taqnyat` (SA)                                          | `TAQNYAT_SMS_TOKEN`, `TAQNYAT_SMS_SENDER`                   |
| WhatsApp | `taqnyat` (SA)                                          | `TAQNYAT_WHATSAPP_TOKEN`, optional `TAQNYAT_WHATSAPP_TEMPLATE_NAMESPACE` |

WhatsApp runs as its own channel via `WHATSAPP_PROVIDER` (default `stub`), separate from `SMS_PROVIDER`. The `SMS_PROVIDER=whatsapp-twilio` legacy alias sends session-text-only over the Twilio WhatsApp number and is retained for pre-P11 callers.

Taqnyat delivery-status callbacks hit `/api/webhooks/taqnyat/delivery/{sms,whatsapp}` — wire `TAQNYAT_WEBHOOK_SECRET` (`openssl rand -hex 32`) as the shared bearer and configure the matching webhook in the Taqnyat console.

Add a new provider: one file in `src/lib/providers/{email,sms,whatsapp}/<name>.ts` implementing the interface, one case in `src/lib/providers/index.ts`.

## Deployment — alternatives

### Railway (single vendor, all-in-one)

Good if you want app + DB in one console. `railway.json` is pre-configured.

```
railway init
railway add postgresql          # provisions DB, sets DATABASE_URL
railway up                      # builds the Dockerfile, deploys
```

Migrations run on boot via the start command in `railway.json`.

### Self-host / government on-prem (Docker)

```bash
docker build -t einai-rsvp .
docker run -p 3000:3000 --env-file .env.local einai-rsvp
```

Output is a standalone Node server; pair with any managed Postgres (Azure, RDS, on-prem).

### Cloudflare — edge caching only

Keep Vercel as the origin. Put Cloudflare in front for WAF, rate-limiting, and cached public RSVP landings. Do not run the Next.js server on Workers — server actions + RSC are still rough there.

## Stack rationale

| Need                           | Chosen                  | Why                                                               |
| ------------------------------ | ----------------------- | ----------------------------------------------------------------- |
| Next.js 14 + server actions    | **Vercel**              | First-class, zero-config, preview per PR, global edge             |
| Postgres                       | **Neon**                | Serverless, per-env branching, one-click from Vercel marketplace  |
| Data residency (future)        | Azure KSA / on-prem     | Code is provider-agnostic — migration is a deploy target change   |
| Public CDN / WAF (optional)    | Cloudflare (in front)   | Sharp signal layer; leaves the app tier alone                     |

## Operating notes

- **Timezone.** `datetime-local` inputs are parsed in `APP_TIMEZONE` (default `Asia/Riyadh`, fixed +03:00). Event times display in the same zone everywhere. If you deploy outside KSA, set `APP_TIMEZONE` to a supported zone in `src/lib/time.ts`.
- **Strict health.** After `DATABASE_URL` is wired, set `HEALTH_REQUIRE_DB=true` so `/api/health` returns 503 on DB outage and Railway surfaces it.
- **AI runtime health.** `/api/health` also reports `ai.name` (`anthropic` / `openrouter` / `unknown`) and `ai.configured` based on the env at response time. The check is side-effect-free — it does NOT probe the provider network-side, so it's safe to poll on short cadences. After a deploy, `curl $APP_URL/api/health` should show `ai.configured: true` for the intended backend; a `false` with `reason: "anthropic_not_configured"` or `"openrouter_not_configured"` means the deploy didn't pick up the required env vars. `reason: "unknown_runtime"` means `AI_RUNTIME` is set to a value the resolver doesn't recognize (typo).
- **Server actions behind a proxy.** If the app sits behind a proxy that rewrites the Host header (e.g. a custom domain through Cloudflare), set `ALLOWED_ORIGINS="https://your-domain"` or server actions may 403.
- **Delivery webhook.** `POST /api/webhooks/delivery` requires `WEBHOOK_SIGNING_SECRET`. Each provider webhook must be wrapped by a small relay that re-signs the body (`x-signature: hex(HMAC_SHA256(body, secret))`). Allowed statuses: `delivered | failed | bounced`.
- **Double-send protection.** `sendCampaign` flips the campaign status to `sending` via a check-and-set; concurrent clicks become no-ops.
- **Rate limit.** `/rsvp/[token]` submissions are rate-limited per client IP (in-memory token bucket, 6 burst / 6 per minute). For multi-replica deploys, swap the Map for Redis in `src/lib/ratelimit.ts`.
- **CSV injection.** `src/lib/contact.csvCell` prefixes any cell starting with `= + - @` to neutralize Excel formula execution on export.
- **Migrations.** First-time deploy uses `prisma db push`. Once schema stabilizes, create a baseline with `npx prisma migrate dev --name init` and switch the Railway start command to `prisma migrate deploy`.
- **Security headers.** CSP-lite, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, HSTS — set in `next.config.js`.

## Scheduled stages (Phase 2)

A campaign can have any number of **stages** — invite → reminder → last-call → thanks — each with its own audience (`all`, `non_responders`, `attending`, `declined`), channels, and template overrides. Stages are scheduled to a timezone-aware moment and fired by a tick endpoint.

### Wiring the tick

1. Set `CRON_SECRET` (`openssl rand -hex 32`) in your app service.
2. Point any scheduler at `POST https://<app>/api/cron/tick` with header `Authorization: Bearer <CRON_SECRET>`, on a minute-ish cadence.

Railway: **+ Create → Cron Job → Scheduled**. Command:

```
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/cron/tick"
```

Schedule: `* * * * *` (every minute). Attach `CRON_SECRET` and `APP_URL` to the cron service as env vars.

Alternatively: Vercel cron, GitHub Actions on a schedule, cron-job.org, or any other HTTP scheduler. The endpoint is idempotent — concurrent ticks can't double-send because each stage is claimed via a CAS (pending → running).

### How a stage runs

1. `dispatchDueStages()` selects stages with `status = pending` and `scheduledFor <= now`, limit 20.
2. Each stage is claimed atomically (CAS), then rendered against its audience with its own template overrides falling back to the campaign's.
3. For each recipient × channel, a fresh `Invitation` row is written; failures go to `status = failed` without blocking the rest.
4. On completion the stage stores `sentCount / skippedCount / failedCount` and emits an `EventLog` entry.

### Run now

Any pending stage has a **Run now** button on the campaign detail page — useful to fire a reminder immediately if the operator doesn't want to wait for the cron.

## Architecture

```
src/
  lib/
    providers/         Thin outbound interface. email/, sms/, one factory.
    db.ts              Prisma singleton.
    contact.ts         Phone/email normalization + dedup key + CSV parser.
    campaigns.ts       Import, stats, send, duplicate detection.
    delivery.ts        Render template → dispatch → log Invitation.
    rsvp.ts            Token lookup + response upsert.
    template.ts        Safe {{token}} renderer + conditional blocks.
    i18n.ts            EN/AR dictionary (RTL-aware).
    auth.ts            HMAC cookie — swap for SAML/Nafath later.
  app/
    page.tsx           Campaigns list.
    campaigns/new      Create.
    campaigns/[id]     Detail + send.
    campaigns/[id]/import       CSV paste → dedupe → create.
    campaigns/[id]/duplicates   Cross-key duplicate review.
    rsvp/[token]       Public RSVP page (EN/AR).
    api/health         Liveness + configured providers.
    api/campaigns/[id]/export   CSV of responses.
    api/webhooks/delivery       Inbound delivery status → invitation.status.
prisma/
  schema.prisma        Campaign · Invitee · Invitation · Response · EventLog.
  seed.ts              Sample campaign + invitees.
```

### Data model

- **Campaign** — one event, its template, its window. `status` drives send/RSVP gating.
- **Invitee** — one person per campaign. `dedupKey` = hash(email|phoneE164), unique per campaign.
- **Invitation** — one delivery attempt on one channel. Tracks `sent | delivered | failed | bounced`.
- **Response** — one per invitee (upserted). Captures `attending`, `guestsCount`, message, IP/UA.
- **EventLog** — append-only audit trail.

### Send flow

`sendCampaign(id, { channel, onlyUnsent })` iterates invitees, renders per-locale template, dispatches via the provider, records `Invitation` + `EventLog`. Re-entrant — `onlyUnsent` skips channels already sent. Move behind BullMQ / Inngest when campaign size demands it; the engine is pure.

### RSVP flow

Invitee receives a signed URL: `${APP_URL}/rsvp/${rsvpToken}`. Token is a `cuid2` (128 bits of CSPRNG), lookup-only. Deadline + campaign status gate submission. Responses upsert — invitee can change their reply until close. Submissions rate-limited per IP.

### Duplicate detection

1. **At import** — `dedupKey` unique per campaign blocks exact matches within paste and against prior imports.
2. **Cross-key review** — `/campaigns/:id/duplicates` surfaces same-name / same-phone / same-email groups that slipped past exact matching.

## Auth

Real user accounts with roles — `admin | editor | viewer`. Scrypt password hashes (`node:crypto`, no native deps), server-side sessions (a row in `Session`), cookie holds a signed session id for integrity.

- **First login.** On the first sign-in attempt, if no users exist and `ADMIN_PASSWORD` is set, the app seeds an admin user `admin@local` with that password. Sign in as that account, then invite your team at `/users`.
- **Role capabilities.** `admin` = everything + team management, `editor` = campaigns + send, `viewer` = read-only. Enforced via `hasRole(user, role)` at route entry. Admin-only links (Team, Events) are hidden from other roles in the sidebar.
- **Session revocation.** Password reset, account disable, and account delete all call `session.deleteMany({ where: { userId } })` — existing tabs are logged out on next request.
- **Audit trail.** Every admin mutation goes through `logAction` (`src/lib/audit.ts`) which auto-populates `actorId` from the current session. Admins can browse the log with filters at `/events`.
- **Nafath SSO.** `/api/auth/nafath/{start,callback}` are wired stubs that return `501 nafath_not_implemented` when `NAFATH_CLIENT_ID` is set, or `503 nafath_not_configured` when it isn't. The surface is stable — swap in the OIDC dance inside those two routes and add a "Sign in with Nafath" button on `/login`; no other callers change.
