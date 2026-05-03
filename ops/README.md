# Ops files

Operational config that lives outside the app code. Apply with `gcloud` /
manual scripts; not loaded at runtime.

## `gcs-cors.json` — Cloud Storage CORS policy

Controls which web origins can call the GCS bucket directly from the
browser (signed-URL uploads / downloads).

**Current contents (DEV ONLY):** `origin: ["*"]` — wide open. Any web
origin can issue authenticated requests. This is fine for a dev bucket
because uploads/downloads still require a server-issued signed URL, but
it widens the blast radius of a leaked signed URL because *any* website
can read it via JS once the URL is known.

### Apply

```bash
gcloud storage buckets update gs://extra-edge-dev-uploads --cors-file=ops/gcs-cors.json
```

CORS changes take ~30-60 seconds to propagate.

### Before going to production

Tighten the origin list:

```json
"origin": [
  "https://app.extraaedge.com",
  "https://admin.extraaedge.com"
]
```

…and apply against the production bucket:

```bash
gcloud storage buckets update gs://extra-edge-prod-uploads --cors-file=ops/gcs-cors.json
```

Keep dev and prod buckets separate so you don't have to maintain a
single CORS list that mixes both.
