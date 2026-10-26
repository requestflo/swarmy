---
title: "Import from Heroku"
description: "Read a Heroku app, review what each part becomes, set up its data and secrets, then copy the database across."
---

**Deploy › Import from Heroku** (`/deploy/heroku`) brings a Heroku app across.
Nothing on Heroku changes at any point, and Heroku keeps serving until you
move the DNS.

## 1. Tell swarmy which app

Pick one of two ways in:

- **With a Heroku token.** Give the app's name and a token from
  `heroku auth:token`. The controller reads the app through the Heroku
  Platform API with GET requests only: the app, its formation, the current
  release's Procfile, add-ons, buildpacks, config vars and domains. The token
  stays in the browser tab while you work and is sent with each step. swarmy
  never stores it, logs it or puts it in the audit log.
- **Paste the files.** This needs no token. Paste the `Procfile`, `app.json`,
  the output of `heroku config -s --app <app>` and, if you like,
  `heroku domains --app <app>`.

## 2. Review the plan

swarmy turns the app into a `swarmy.yaml` and checks it with the same parser a
push runs. It then says what each part becomes:

| On Heroku | On swarmy |
|---|---|
| Procfile `web` | `services.web`: the routed service. It reads `$PORT` as it did on Heroku, and swarmy sets `PORT`. |
| Other process types | Workers with no address. A `clock`, `scheduler` or `beat` process runs as one copy. |
| `release` | `services.web.release`: runs in the new image before each deploy. If it fails, the deploy stops. |
| Formation quantity | `replicas:` |
| Dyno size | Resource limits (see the table below) |
| Heroku Postgres | A managed Postgres. `DATABASE_URL` is filled in through the connection. Premium, Private and Shield plans get a standby copy (`ha: failover`). |
| Heroku Redis | A managed cache (Valkey). `REDIS_URL` points at it. |
| Heroku Scheduler | Listed as a to-do. The Platform API doesn't expose Scheduler's jobs, so add each one under `jobs:`. |
| Config vars | `env:`. Values that look secret become `${{ secrets.<name> }}` and never go in the file. |
| Custom domains | `services.web.domains`. The `*.herokuapp.com` name stays with Heroku. |
| Buildpacks | One Railpack build. A second language becomes `build.packages`, and ffmpeg, ImageMagick, libvips and poppler become `build.apt`. Other buildpacks are listed with what to do instead. |
| Other add-ons | Listed, each with what to do. Keep the hosted service: its config vars come across. |

Anything that doesn't come across is listed with the reason and what to do.
Nothing is dropped silently.

### Dyno sizes

Memory carries over exactly. Shared dynos take the swarmy size with the same
memory. Dedicated dynos keep their vCPUs. The limits apply to each copy.

| Heroku dyno | Memory | swarmy.yaml |
|---|---|---|
| eco, basic, standard-1x | 512 MB | `size: small` (0.5 CPU, 512 MB) |
| standard-2x, private-s, shield-s | 1 GB | `size: medium` (1 CPU, 1 GB) |
| performance-m, private-m, shield-m | 2.5 GB | `memory: 2560mb`, `cpu: 2` |
| performance-l, private-l, shield-l | 14 GB | `memory: 14gb`, `cpu: 8` |
| performance-l-ram, private-l-ram, shield-l-ram | 30 GB | `memory: 30gb`, `cpu: 4` |
| performance-xl, private-xl, shield-xl | 62 GB | `memory: 62gb`, `cpu: 8` |
| performance-2xl, private-2xl, shield-2xl | 126 GB | `memory: 126gb`, `cpu: 16` |

## 3. Deploy

swarmy builds an app from git, so Deploy sets up what can run before the code
arrives:

- It starts each managed Postgres and cache. It uses the same code a push
  uses, so the first push takes them over as they are. That push asks you to
  confirm the takeover, because the stores existed before the file did.
- It seals each secret-looking config var as a swarmy secret, using Heroku's
  value. If a secret with that name already exists, swarmy keeps it and tells
  you. If another app owns it, give the variable its own secret name in
  `swarmy.yaml`.

Deploy needs an admin or owner. Then commit the `swarmy.yaml` at the root of
the app's repo and connect the repo (**Connect a repo**). That push builds the
app with Railpack and deploys its services.

## 4. Copy the data

Copying the database is a separate step that you run yourself. Type
`<app>/<database>` to confirm, for example `shop-classic/db`. swarmy reads
Heroku's `DATABASE_URL` and streams `pg_dump -Fc` (over TLS) into
`pg_restore --no-owner` on the new database. The copy runs once, in the
database's own image, on the database's server.

- The copy only goes into an empty database. If the database already has
  tables, it stops without changing anything.
- Heroku is only read. Anything written there after the copy stays there, so
  copy just before you switch over.
- The page waits for the copy to finish, for up to an hour. For a bigger
  database, use the manual steps below.
- The copy needs a `pg_dump` at least as new as Heroku's server. If Heroku
  runs a newer Postgres than the new database, set `version:` in
  `swarmy.yaml` to match first.

### By hand

The plan page also lists the manual route, with the commands filled in for
your app:

1. Run `heroku pg:backups:capture` and `heroku pg:backups:download`.
2. Store the dump in the database's backup destination, tagged as a swarmy
   `pg_dump` backup.
3. Restore it from the app's **Backups** tab with **Restore in place**.
   swarmy saves the current data first.

To bring config vars across by hand, run `heroku config --shell` and paste the
output into **Config › Variables & secrets › Paste .env**.
