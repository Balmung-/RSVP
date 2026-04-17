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

| Channel | `EMAIL_PROVIDER` / `SMS_PROVIDER` | Required env                                                |
| ------- | --------------------------------- | ----------------------------------------------------------- |
| Email   | `sendgrid`                        | `SENDGRID_API_KEY`                                          |
| Email   | `resend`                          | `RESEND_API_KEY`                                            |
| SMS     | `twilio`                          | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`    |
| SMS     | `unifonic` (SA)                   | `UNIFONIC_APP_SID`, `UNIFONIC_SENDER_NAME`                  |
| SMS     | `msegat` (SA)                     | `MSEGAT_API_KEY`, `MSEGAT_USERNAME`, `SMS_SENDER_ID`        |

Add a new provider: one file in `src/lib/providers/{email,sms}/<name>.ts` implementing the interface, one case in `src/lib/providers/index.ts`.

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

Invitee receives a signed URL: `${APP_URL}/rsvp/${rsvpToken}`. Token is a `cuid`, lookup-only. Deadline + campaign status gate submission. Responses upsert — invitee can change their reply until close.

### Duplicate detection

1. **At import** — `dedupKey` unique per campaign blocks exact matches within paste and against prior imports.
2. **Cross-key review** — `/campaigns/:id/duplicates` surfaces same-name / same-phone / same-email groups that slipped past exact matching.

## Auth

Single-password HMAC cookie by default. The surface in `src/lib/auth.ts` is tiny — `authenticate`, `issueSession`, `clearSession`, `isAuthed`. Swap to SAML, OIDC, or Nafath (KSA national SSO) by reimplementing those four; no callers change.
