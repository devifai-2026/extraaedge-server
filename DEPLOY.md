# Deploying

**Push to `main` and it ships.** `.github/workflows/deploy.yml` SSHes into the
Hostinger box, updates the code, restarts Passenger, and smoke-tests the API.
Watch a run at **Actions → Deploy to Hostinger**, or `gh run watch`.

Nothing else auto-deploys from this repo. The sibling frontends deploy on
Render on their own (`extraaedge-admin` from `prod`, `extraaedge-product-owner`
from `main`).

## How this box is actually laid out

⚠️ **`ops/systemd/` does not describe production.** There is no systemd unit and
no `/opt/extraaedge` — that documents a VPS layout this deployment never used.
The Render blueprint (`render.yaml`) is also inactive: `extraaedge-api` on
Render is **suspended**.

Production is **LiteSpeed Passenger on Hostinger shared hosting**. From
`~/domains/admissioncrm.live/public_html/.htaccess`:

| Setting | Value |
|---|---|
| `PassengerAppRoot` | `~/domains/admissioncrm.live/.builds/current/nodejs` |
| `PassengerStartupFile` | `src/app.js` |
| `PassengerRestartDir` | `~/domains/admissioncrm.live/.builds/current/nodejs/tmp` |
| `PassengerNodejs` | `/opt/alt/alt-nodejs20/root/bin/node` |

Two directories, and confusing them is the classic failure:

```
~/domains/admissioncrm.live/nodejs          <- git checkout (the SOURCE)
~/domains/admissioncrm.live/.builds/
    current -> versions/<uuid>/             <- symlink
    current/nodejs/                         <- what Passenger RUNS (a copy, not a repo)
```

Pulling into `nodejs/` and touching `nodejs/tmp/restart.txt` changes nothing
live. That mistake cost an hour once: three deploys reported success, the
checkout really was on the new commit, and the running app never changed.

The workflow therefore pulls into the checkout, `rsync`s `src/` into
`.builds/current/nodejs/src/`, and touches the **build's** `tmp/restart.txt`.
Only `src/` is synced, so the build's own `.env` and `node_modules` are never
clobbered; dependencies are reinstalled only when `package.json` differs.

## Verifying a deploy by hand

```bash
curl -s https://admissioncrm.live/healthz
curl -s -o /dev/null -w '%{http_code}\n' https://admissioncrm.live/api/v1/qa-reviews/parameters
```

**401 means the route exists (new code). 404 means old code.**

Do **not** use `/users/*` or `/platform/*` for this check — those routers mount
`authRequired` before routing, so they return 401 for unknown paths too and
will happily lie to you. Pick a route whose mount lives in `src/routes.js`.

## Credentials

The workflow authenticates with a dedicated ed25519 key
(`github-actions-deploy@extraaedge`) held in the repo secrets:
`HOSTINGER_SSH_KEY`, `HOSTINGER_KNOWN_HOSTS` (pinned host key),
`HOSTINGER_HOST`, `HOSTINGER_PORT`, `HOSTINGER_USER`.

To rotate: generate a new keypair, replace the `HOSTINGER_SSH_KEY` secret,
append the public half to `~/.ssh/authorized_keys` on the box, and remove the
old line.

## Migrations

Not run by the workflow — schema changes should be deliberate. Run them from a
machine that can reach the database:

```bash
node scripts/run-migrations.js --target=system
node scripts/run-migrations.js --target=tenant     # fans out over every tenant DB
```

Note the `=`. `npm run migrate:tenant` is **broken**: the arg parser only
accepts `--target=<x>`, so the npm alias dies with `Unknown target: true`.

## Manual deploy (if Actions is down)

```bash
ssh -p 65002 u402632959@82.25.120.153
cd ~/domains/admissioncrm.live/nodejs
git pull --ff-only origin main
rsync -a --delete src/ ../.builds/current/nodejs/src/
touch ../.builds/current/nodejs/tmp/restart.txt
```

The fully supported path is hPanel → the Node.js app → Deploy/Restart, which
builds a fresh `versions/<uuid>` snapshot and repoints `current`.
