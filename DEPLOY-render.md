# Deploying to Render

This backend runs as **two Render services** that talk to each other on Render's
private network:

| Service                  | Type            | Runtime        | Why                                            |
|--------------------------|-----------------|----------------|------------------------------------------------|
| `extraaedge-api`         | Web             | Node           | Express API + socket.io. No browser needed.    |
| `extraaedge-wa-gateway`  | Private (pserv) | Docker+Chromium| Holds live whatsapp-web.js clients in memory.  |

Both are defined in [`render.yaml`](./render.yaml) (a Blueprint). The gateway
uses [`Dockerfile.gateway`](./Dockerfile.gateway), which installs Chromium via
apt and points puppeteer at it.

## Why the gateway is separate, Docker, and single-instance

- **Docker + Chromium:** whatsapp-web.js drives a real headless Chrome. Render's
  Node runtime has no browser, so the gateway image apt-installs `chromium` and
  sets `WA_PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`.
- **`numInstances: 1` (never autoscale):** each connected user's WhatsApp client
  lives in that process's memory. A second instance couldn't see those clients.
- **Sessions survive restarts:** auth is persisted to GCS (RemoteAuth), so a
  redeploy re-links connected users automatically — no re-scan.

## First-time setup

1. **Push these files** (`render.yaml`, `Dockerfile.gateway`, `.dockerignore`)
   to the `main` branch.
2. In Render: **New → Blueprint**, point at this repo. Render reads `render.yaml`
   and proposes both services + the `extraaedge-shared` env group.
3. **Fill the secrets** in the `extraaedge-shared` env group (all marked
   `sync:false`, so Render prompts and never stores them in git):
   - `JWT_SECRET`, `TENANT_SECRET_ENCRYPTION_KEY` (64 hex chars)
   - `SYSTEM_DB_*`, `TENANT_DB_*`
   - `GCS_PROJECT_ID`, `GCS_BUCKET`
   - `BREVO_*`, `MESSAGECENTRAL_*`, `RAZORPAY_*`, `EXOTEL_*` (still validated at
     boot by `env.js`, even though WhatsApp no longer uses WABridge)
   - `REDIS_URL` (for BullMQ; the gateway does NOT use a queue but shares env)
   - `WA_GATEWAY_INTERNAL_SECRET` is auto-generated and shared to both services.
4. **GCS credentials:** `src/lib/r2.js` currently embeds the service-account JSON,
   so no extra Render config is needed for storage. (If you later externalize it,
   add `GCS_CREDENTIALS_JSON`.)
5. **Apply.** Render builds the API (npm) and the gateway (Docker).
6. **Run migrations once** against each tenant DB (Render Shell on the API, or
   locally): `node scripts/run-migrations.js --target=system` then
   `node scripts/run-migrations.js --target=tenant`. (Note the `=` — the
   `migrate:*` npm scripts have a known arg quirk with the space form.)

## How the two services find each other

Set automatically in `render.yaml` via Render private hostnames (service name):
- API → gateway: `WA_GATEWAY_URL=http://extraaedge-wa-gateway:4100`
- gateway → API: `WA_API_BASE_URL=http://extraaedge-api:4000/api/v1`
  (the gateway POSTs events to `${WA_API_BASE_URL}/internal/wa/notify`)

Both share `WA_GATEWAY_INTERNAL_SECRET` from the env group, so the internal
calls authenticate. If you rename a service, update these two values.

## Frontend

Point the admin app's `VITE_API_BASE_URL` at the public API URL
(`https://extraaedge-api.onrender.com/api/v1`). Socket.io connects to the same
host. The gateway has **no public URL** — it's only reached by the API.

## Gotchas

- **`EADDRINUSE` locally** just means a process already holds the port; it has
  nothing to do with Render.
- **Memory:** each connected WhatsApp client is ~50–150MB of Chromium. Size the
  gateway plan for your expected concurrent connections; one process realistically
  holds ~30–80. Beyond that you must shard (route by hash) — `src/lib/wa-gateway.js`
  keeps base-URL selection in one function for exactly that.
- **Ban risk:** whatsapp-web.js is unofficial. This path is opt-in personal
  numbers with a per-user send rate limit (`WA_SEND_RATE_PER_MINUTE`); don't bulk
  blast through it.
- **Cold starts:** if the gateway restarts, `restoreOnBoot` re-links connected
  users from GCS (throttled by `WA_SESSION_RESTORE_CONCURRENCY`). Users briefly
  see "connecting" until their client is ready again.
