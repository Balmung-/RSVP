# Operations — deploy, verify, rotate, recover

Operator-facing runbook. Consult this during a deploy or an incident. `README.md` covers first-time setup; this doc covers steady-state operation.

Single source of truth for post-deploy verification: `GET /api/health`.

---

## 1. AI runtime env standard

The app ships with two AI backends; one must be fully configured. Default is `anthropic`.

| Variable | Anthropic | OpenRouter |
|----------|-----------|------------|
| `AI_RUNTIME` | `anthropic` (or unset) | `openrouter` |
| `ANTHROPIC_API_KEY` | required | — |
| `OPENROUTER_API_KEY` | — | required |
| `OPENROUTER_MODEL` | — | required (e.g. `anthropic/claude-sonnet-4.6`) |
| `OPENROUTER_HTTP_REFERER` | — | optional (analytics) |
| `OPENROUTER_X_TITLE` | — | optional (analytics) |

Switching backends is an env change + restart. The chat route re-reads env per request, so no cache flush is needed — but the running process still needs to be restarted so the new env is in `process.env`.

Both backends expose the same tool-use contract internally. Switching does not change what the operator sees in `/chat`; it only changes who the model requests flow through.

**OpenRouter model id note:** OpenRouter model ids are namespaced (`vendor/model-id`, dots not dashes in the version). `anthropic/claude-sonnet-4.6` is the current recommended id. Verify at <https://openrouter.ai/models>.

---

## 2. Post-deploy verification

After every deploy, run one curl:

```bash
curl -s "$APP_URL/api/health" | jq .
```

Expected green shape:

```json
{
  "ok": true,
  "db": "up",
  "email": "sendgrid",
  "sms": "taqnyat",
  "ai": { "name": "anthropic", "configured": true }
}
```

Green-light rules:

- `ok: true` AND `db: "up"` — app has DB reachability
- `ai.configured: true` — the selected backend has all required env present
- No `dbError` field

Red-flag rules (all indicate a deploy problem, not a runtime bug):

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| `ai.configured: false`, `reason: "anthropic_not_configured"` | Deploy did not pick up `ANTHROPIC_API_KEY` | Set secret in platform (Railway / Vercel / etc.), restart service, recheck |
| `ai.configured: false`, `reason: "openrouter_not_configured"` | Missing `OPENROUTER_API_KEY` or `OPENROUTER_MODEL` (both required) | Set both secrets, restart, recheck |
| `ai.configured: false`, `reason: "unknown_runtime"` | `AI_RUNTIME` is set to a typo (resolver is strict, case-insensitive) | Valid values: `anthropic`, `openrouter`, or unset (defaults to `anthropic`). Correct + restart |
| `db: "down"` with error | Network to Postgres is broken, or `DATABASE_URL` has drifted | Verify `DATABASE_URL` in platform secrets matches the live DB. If DB rotated password, update secret + restart |
| `ok: false` under `HEALTH_REQUIRE_DB=true` | DB down; platform will auto-restart | Address the DB before investigating the app |

The AI probe is **side-effect-free** — it reports env presence only, not provider reachability. `ai.configured: true` + real `/api/chat` 5xx means the key is present but invalid or the provider is unreachable (see §6).

---

## 3. Secret rotation

### AI provider key (Anthropic / OpenRouter)

1. Rotate the key at the provider's console.
2. Update the platform secret (Railway → Variables; Vercel → Environment Variables).
3. Restart the service.
4. `curl $APP_URL/api/health` — `ai.configured` must be `true`.
5. Drive one turn in `/chat` to confirm the new key authenticates against the provider (the health probe does not hit the wire).

### `ADMIN_PASSWORD`

Only read on first boot when the user table is empty. After the first admin is seeded, this var is **ignored**. To rotate an admin credential, create a new admin at `/users` and delete the old one.

### `SESSION_SECRET`

Rotating invalidates every active session. All users will be signed out. Only rotate if compromised.

1. `openssl rand -base64 32` — generate a new 32-byte random.
2. Update the platform secret.
3. Restart.

### `OAUTH_ENCRYPTION_KEY`

Encrypts Gmail OAuth tokens at rest. Rotating invalidates every stored token — admins must re-connect Gmail at `/settings → Integrations`. Only rotate if compromised.

1. `openssl rand -base64 32`.
2. Update the platform secret.
3. Restart.
4. Notify admins to re-connect.

### Webhook secrets (`WEBHOOK_SIGNING_SECRET`, `INBOUND_WEBHOOK_SECRET`, `CRON_SECRET`)

Each secret has a provider-side relay that must be updated in lockstep. Schedule rotation during low-traffic hours — requests signed with the old secret between app restart and relay update will be dropped.

1. `openssl rand -hex 32` — generate.
2. Update the platform secret.
3. Restart.
4. Update the provider-side sender:
   - `WEBHOOK_SIGNING_SECRET` → delivery-status relay (SendGrid/Resend/Twilio event webhook wrapper).
   - `INBOUND_WEBHOOK_SECRET` → inbound-parse sender (SendGrid Inbound Parse header, Taqnyat webhook `x-inbound-secret` or `?key=`).
   - `CRON_SECRET` → scheduler (Railway cron command, Vercel cron, GH Actions, cron-job.org).

---

## 4. Staging / prod parity

Environments **should** differ in exactly these vars:

- `DATABASE_URL` — separate DBs
- `APP_URL` — different hostnames
- `SESSION_SECRET`, `OAUTH_ENCRYPTION_KEY` — distinct random values (compromise in one does not compromise the other)
- `WEBHOOK_SIGNING_SECRET`, `INBOUND_WEBHOOK_SECRET`, `CRON_SECRET` — distinct random values
- Possibly `EMAIL_FROM` and `SMS_SENDER_ID` if you want staging sends visibly marked

Everything else **should** be identical between staging and prod:

- `AI_RUNTIME` and provider-key/model selection
- `EMAIL_PROVIDER`, `SMS_PROVIDER`
- `APP_TIMEZONE`, `APP_BRAND`, `DEFAULT_LOCALE`, `DEFAULT_COUNTRY`
- `APPROVAL_THRESHOLD`, `INBOUND_AUTO_ACK`, `DELIVERABILITY_DIGEST`, `DIGEST_HOUR`
- `TEAMS_ENABLED`
- `HEALTH_REQUIRE_DB`

Drift in the "should be identical" group is the leading cause of "works in staging, breaks in prod" incidents.

### Promotion checklist: staging → prod

- [ ] Staging `/api/health` green
- [ ] Staging `/chat` drove at least one end-to-end turn that hit a tool
- [ ] Staging `/campaigns` sent a test invite and received a provider webhook back
- [ ] Staging migrations ran clean (`prisma migrate deploy` succeeded)
- [ ] Prod env vars reviewed against the "should be identical" list above — no unexpected drift
- [ ] Prod backup is recent (if DB-level backups are wired)

---

## 5. Restart / deploy / rollback

### In-memory state that matters across restarts

None that is critical. Specifically:

- Sessions are DB-backed (Prisma-managed).
- RSVP form rate-limit token buckets are in-memory and reset on restart — acceptable because the app is single-replica in the current posture.
- Widget slot coordination is process-local but rebuilt from DB on reconnect (transcript rebuild).
- Prompt cache / SDK pooling is per-process; restart cold-starts the first request.

A restart is safe at any time.

### Deploy procedure

1. Merge to `main`.
2. Platform (Railway / Vercel) picks up the push and builds.
3. Service restarts automatically on successful build.
4. `curl $APP_URL/api/health` — green-light per §2.
5. If `ai.configured: false`, the deploy did not pick up the env — verify secrets + restart again.

### Rollback procedure

The app has no forward-only runtime state; a code rollback is safe.

1. Revert the bad commit on `main` (`git revert <sha>`), OR trigger a re-deploy of a prior green commit in the platform UI.
2. Wait for automatic build + restart.
3. `curl /api/health` — green.
4. Verify the regression is gone in `/chat`.

**Schema migrations are one-way.** Plan schema changes as additive + non-breaking so rollback is a pure code revert. If a rollback requires undoing a schema change, write an explicit reverse migration and run `prisma migrate deploy` on the rollback commit before restarting.

---

## 6. Failure recovery

### DB down

- `/api/health` reports `db: "down"` with `dbError` populated.
- If `HEALTH_REQUIRE_DB=true`, the endpoint returns 503 and the platform auto-restarts the service until the DB is back. Check the DB provider's status page (Neon / Railway / Azure / etc.) before restarting the app.
- If the DB is reachable from a laptop but not from the app, check for `DATABASE_URL` drift: different network, wrong password after rotation, pooled vs direct URL mix-up.

### AI provider down

- `/api/health` still reports `ai.configured: true` — the probe is env-only.
- `/api/chat` turns 5xx with provider-side error content surfaced in the transcript.
- Check provider status pages:
  - Anthropic: <https://status.anthropic.com>
  - OpenRouter: <https://status.openrouter.ai>
- If sustained, flip `AI_RUNTIME` to the other backend and restart. Both backends expose the same tool-use contract; the chat route does not care which one answers.
- If both are down, there is no workaround — queue operator work in email/SMS sends (which do not depend on the AI runtime) until one recovers.

### Email / SMS send failures

- `/campaigns` dashboard counts failures per channel. Click into a campaign for per-invite status.
- For Taqnyat debugging: inspect the inbound webhook log (failed deliveries surface as provider webhook events).
- Break-glass: flip `EMAIL_PROVIDER=stub` / `SMS_PROVIDER=stub` to suspend all outbound while investigating. Stubs emit ok responses without actually sending — operators can continue working without compounding the delivery failure rate while the provider is fixed.

### Webhook flood / bad actor

- `/api/webhooks/delivery` drops any request whose `x-signature` HMAC does not match the body + `WEBHOOK_SIGNING_SECRET`.
- `/api/webhooks/inbound/*` drops any request without a valid `x-inbound-secret` header (or `?key=` for SMS providers that cannot add custom headers).
- `/api/cron/tick` drops any request without `Authorization: Bearer $CRON_SECRET`.
- If a secret is suspected compromised, rotate per §3 immediately.

### AI provider key revoked mid-flight

- Probe still reports `configured: true` (env is present).
- `/api/chat` turns error with the provider's 401 / 403 surfaced.
- Rotate the key per §3 and restart.

---

## 7. Provisioning a new tenant / office

Not yet automated. Manual procedure:

1. Provision DB (Neon branch or fresh Postgres).
2. Deploy app (Vercel project or Railway service) with env per §1 + standard provider selection.
3. Set `ADMIN_PASSWORD` to a strong one-time value.
4. Visit `/login` — the first login with `admin@local` + that password seeds the admin user. After that, `ADMIN_PASSWORD` is ignored.
5. Rotate `ADMIN_PASSWORD` out of the platform secret (it is no longer read).
6. Admin invites team members at `/users`.
7. Admin connects the office Gmail at `/settings → Integrations` (if using Gmail as the email backend).
8. Admin uploads templates, campaigns, contacts as needed.

A proper provisioning flow (one command / one click per tenant) is future work.
