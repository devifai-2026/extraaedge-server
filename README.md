# ExtraaEdge Backend

Multi-tenant educational CRM — Node.js + Express + PostgreSQL, database-per-tenant, ES modules, functional style.

Companion to [extraedge-admin](../extraedge-admin) (React frontend). See `docs/BACKEND_PLAN.md` in that repo for the design spec.

---

## Architecture at a glance

- **Single-repo monolith** — clean module boundaries (`src/modules/<domain>/`), workers split into their own processes.
- **DB-per-tenant** — one Postgres database per institute + one shared `extraaedge_system` DB (tenants directory, platform staff, audit).
- **Providers**
  - Email: **Brevo**
  - SMS + OTP: **MessageCentral** (DLT-compliant for India)
  - WhatsApp: **WABridge**
  - Payments: **Razorpay**
  - Audio calls (bridge-call): **Exotel** — recordings stored in Cloudflare R2
  - Object store: **Cloudflare R2** (S3-compatible, free egress)
  - Queue: **BullMQ on Redis** (falls back to in-process if `REDIS_URL` is unset)
- **Hosting**: VPS-native. No Docker. systemd supervises the API + every worker.
- **Reverse proxy**: Nginx with wildcard subdomain routing (`*.productivo.in`).

---

## Prerequisites (local dev)

- Node.js 20.11+ (`nvm use` reads `.nvmrc`)
- PostgreSQL 15+ installed natively — `brew install postgresql@15` on macOS, `apt install postgresql-15` on Debian/Ubuntu
- Redis 7 (optional — skip if you want in-process queues)
- A Cloudflare R2 bucket + API token (only for upload flows)
- Accounts with Brevo / MessageCentral / WABridge / Razorpay / Exotel (use dummy keys first — everything runs locally without them)

---

## First-time setup

```bash
git clone <this-repo>
cd extraaedge_backend
nvm use                          # pins Node version
npm install
cp .env.example .env             # edit values; dummy keys are fine for first run
npm run setup                    # creates system DB + demo tenant + product_owner
npm run dev                      # starts API on :4000
```

`npm run setup` creates `extraaedge_system`, runs system migrations, bootstraps one `product_owner` (`[email protected]` / `ChangeMe123!`), provisions a demo tenant at slug `demo` with a super_admin (`[email protected]` / `ChangeMe123!`).

**Change both passwords immediately.**

In a second terminal, start the background workers:

```bash
npm run worker:all               # runs every worker in-process (dev only)
# — or —
npm run worker:email             # one worker per terminal in dev
npm run worker:rules
# …etc
```

### Test the demo flow

```bash
# 1) log in as product_owner (system)
curl -s http://localhost:4000/api/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"[email protected]","password":"ChangeMe123!"}'

# 2) log in as the tenant super_admin
curl -s http://localhost:4000/api/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"[email protected]","password":"ChangeMe123!","tenant_slug":"demo"}'
```

`/auth/me` returns the user, tenant branding (logo/colors/company name for the sidebar), and `allowed_tabs` — the frontend uses these to render the correct sidebar dynamically.

---

## Key commands

| Command | What it does |
|---|---|
| `npm run dev` | Start API (nodemon) |
| `npm start` | Start API (plain node) |
| `npm run setup` | One-shot local bootstrap |
| `npm run migrate:system` | Apply system-DB migrations |
| `npm run migrate:tenant` | Fan out tenant migrations across every tenant DB |
| `npm run migrate:tenant -- --slug=demo` | Apply to a single tenant |
| `npm run provision:tenant -- --name="X" --slug="x" --admin-name="Y" [email protected] --admin-password='...'` | Provision a new tenant |
| `npm run create:product-owner -- --name="..." --email="..." --password="..."` | Bootstrap / no-op |
| `npm run seed:dev` | Seed the demo tenant with sample data |
| `npm run backup` | Run `scripts/backup-all-dbs.sh` (pg_dump → R2) |
| `npm run worker:all` | Run every worker in one process (dev) |
| `npm run worker:<name>` | Run a specific worker |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests only (pure functions) |
| `npm run test:integration` | Integration tests (needs Postgres) |

---

## Production deploy (VPS)

1. Provision VPS, install Node, Postgres, Redis, Nginx, certbot.
2. Clone the repo to `/opt/extraaedge`, run `npm ci --omit=dev`.
3. Put production `.env` at `/etc/extraaedge/.env` (mode 600, owned by root).
4. Run system migrations: `npm run migrate:system`.
5. Copy systemd units from `ops/systemd/` and enable them (see `ops/systemd/README.md`).
6. Nginx config: `ops/nginx/extraaedge.conf` — symlink into `/etc/nginx/sites-enabled/`.
7. Wildcard Let's Encrypt cert via certbot DNS-01.
8. Nightly cron: `0 2 * * * bash /opt/extraaedge/scripts/backup-all-dbs.sh`.

---

## Repo layout

```
extraaedge_backend/
├── src/
│   ├── config/               # env.js (zod-validated), constants
│   ├── db/                   # system + tenant pool factories, migrations
│   ├── middleware/           # auth, tenant, rbac, validate, rateLimit, idleGuard, workTracker, optimisticLock, error
│   ├── lib/                  # jwt, logger, r2, queue, redis, csv, templating, pdf, otp, rrule, crypto, providers/*
│   ├── services/             # cross-module helpers (tenant-provisioning, platform-audit, rule-engine)
│   ├── modules/<domain>/     # routes, controller, service, repo, schema (where sized)
│   ├── workers/              # background workers (one file per worker)
│   ├── utils/
│   ├── app.js                # express wiring
│   ├── routes.js             # module registry
│   └── index.js              # bootstrap + graceful shutdown
├── scripts/                  # setup, migrations, provisioning, backup
├── ops/
│   ├── systemd/              # service + template units
│   └── nginx/
├── tests/                    # unit + integration
└── docs/                     # bulk-lead-template.csv, BULK_INGESTION_TEMPLATE.md
```

Every module in `src/modules/<domain>/` keeps the same contract:

```
routes.js       # HTTP wiring
controller.js   # req → service → res (no SQL, no business logic)
service.js      # business logic (no req/res)
repo.js         # parameterized SQL only
schema.js       # zod validation schemas
```

---

## Roles

### Platform-level (in `extraaedge_system` DB)
- **`product_owner`** — single top-level admin. Only role that can provision tenants. Enforced by partial unique index.
- **`support_admin`** — Devifai support staff. Read-only by default; can impersonate tenant users with full audit trail.

### Tenant-level (in each tenant DB, driven by `custom_roles` + `tab_permissions`)
- **`super_admin`** — institute owner. Exempt from work-time tracking.
- **`sales_manager`** — sees own + team's leads (recursive `manager_id` CTE).
- **`counsellor`** — sees only assigned leads.

Tenants can **create additional custom roles** with their own tab-permission maps (e.g., "Admissions Head"). Every tab of the frontend is gated by a key in `constants.js::DEFAULT_TAB_KEYS`.

---

## Security invariants

- **15-minute idle logout** enforced both client-side and server-side (`idleGuard` middleware → `SESSION_IDLE`).
- **Work-time tracking** writes a UTC-minute bucket per API call for every role except `super_admin`.
- **Optimistic locking** — mutating endpoints require `If-Match: <updated_at>`; mismatch returns 409.
- **Field-level permissions** redact `hidden` fields + reject writes on `readonly` fields per role/entity.
- **All SQL parameterized**. No string interpolation.
- **Tenant DB credentials encrypted at rest** with AES-256-GCM (`TENANT_SECRET_ENCRYPTION_KEY`).
- **Provider webhooks signature-verified** (Razorpay HMAC, WABridge, Brevo).
- **Suppression list** blocks sends to addresses that bounced/unsubscribed.
- **Marketing WhatsApp sends** require an `optin_log` row — returns 403 `NO_OPTIN` otherwise.
- **Rate limits** — global per IP+tenant, stricter on login + password reset.

---

## Event bus + workers

Events are published via `lib/queue.js::publish(QUEUE_NAMES.EVENTS, type, data)` whenever something downstream should react.

| Worker | Purpose |
|---|---|
| `email-sender` · `sms-sender` · `whatsapp-sender` | Consume channel queues, render templates, call providers, update `message_log` |
| `bulk-import-worker` | CSV preview + commit from R2 → `leads` |
| `bulk-export-worker` | Stream filtered leads to CSV → R2 |
| `campaign-runner` | Expand bulk campaign audience, enqueue sends |
| `drip-scheduler` | 5-min cron — enqueue due drip steps |
| `scheduled-send-runner` | 1-min cron — one-off scheduled sends |
| `workflow-executor` | Walks workflow DAG (trigger/action/condition/wait) |
| `rule-processor` | Assignment rules + lead score + generic rule engine |
| `notification-worker` | In-app notifications + SSE push |
| `outbound-webhook-dispatcher` | Fan out events to tenant webhook subscribers (signed HMAC) |
| `pdf-report-worker` | Lead PDF + dashboard PDF → R2 |
| `duplicate-scanner` | Nightly fuzzy-dup detection |
| `followup-reminder-scheduler` | 1-min cron — notifies 15 min before follow-up |
| `missed-followup-scanner` | 5-min cron — flips overdue follow-ups to `missed` |
| `sla-scanner` | 10-min cron — flags stale leads, escalates, auto-resolves |
| `referral-crediter` | Event-driven — credits referrer on `payment.succeeded` |
| `attribution-snapshotter` | Event-driven — immutable first/last-touch snapshot at conversion |
| `touch-recorder` | Event-driven — appends `lead_touches`, updates last-touch columns on leads |

---

## Frontend contract

The React frontend logs in with `POST /auth/login`, receives:

```json
{
  "access_token": "…",
  "refresh_token": "…",
  "user": { "id": "…", "role": "super_admin", "role_name": "Admissions Head", … },
  "tenant": {
    "slug": "speedup",
    "brand_name": "Speedup Innovation",
    "logo_url": "https://…",
    "brand_primary_color": "#E53935",
    …
  },
  "allowed_tabs": ["dashboard", "leads", "settings.email_templates", …]
}
```

- `tenant.brand_name` + `tenant.logo_url` replace the hardcoded "SPEEDUP INNOVATION" in the sidebar.
- `allowed_tabs` drives which sidebar items + routes render.
- Every authenticated request adds `POST /auth/session/heartbeat` every ~5 min of activity to keep the session alive; missing heartbeats past 15 min → 401 `SESSION_IDLE`.

---

## Troubleshooting

- **Migrations fail** — ensure the Postgres role has `CREATEDB` + `pgcrypto` extension is permitted.
- **R2 uploads fail** — check `R2_ACCOUNT_ID`, `R2_BUCKET`, token permissions.
- **SSE disconnects through Nginx** — verify `proxy_buffering off` on `/api/v1/notifications/stream`.
- **Tenant login says "slug not found"** — the slug is extracted from subdomain OR `X-Tenant-Slug` header OR JWT; check DNS wildcard.
- **Exotel calls silent** — confirm counsellor's phone number is registered against the ExoPhone in Exotel dashboard.
- **Template variable not rendering** — confirm the key exists in `template_variables` and matches the case of the placeholder.

---

## What's next

See the frontend companion repo's `docs/FEATURE_PLAN.md` and `docs/BACKEND_PLAN.md` for the full feature list and what was built vs. deferred. Everything listed as Phase 0–5 is implemented here.
