# Messaging & automation — "queues, workflows and webhooks, native to the swarm"

**Status: canonical product design (2026-07). Pairs with the `reconcile-workers`
skill for the how (worker loops), and rides on `add-feature-slice` +
`docker-native-storage`.**

## The feeling we are building

Someone running an app on swarmy should never reach for a second SaaS to move
work around, run something on a schedule, or catch an event from Stripe. It is
all one tab on the stack they already operate:

1. They open a stack, click **Messaging**, and see four sections stacked for the
   one app — **Queues**, **Workflows**, **Webhooks**, **Scheduled jobs** — each
   with a plain-words hero ("depths, autoscale, dead letters"; "cron, one-shot
   containers & execs").
2. They **Attach a queue** to a worker service, pick the backing cache cluster,
   and set `scale 1→5 workers per 100 waiting jobs`. Depth, active and failed
   counts appear live; when the backlog spikes, worker replicas climb on their
   own and settle back down.
3. A job piles up in the dead-letter list. They browse `orders:dead`, requeue a
   batch, and watch it drain — no redis-cli, no SSH.
4. They build a **Workflow**: run a migration container, exec a smoke check into
   the api, POST a webhook, then **wait for approval** before the last step. A
   colleague approves in the run timeline; the run resumes and finishes green.
5. They give Stripe a **public URL** to paste — `POST /hooks/i/<org>/<slug>`.
   swarmy verifies every signature, stores each delivery, and pushes the good
   ones into a queue their worker is already draining. A bad signature still
   shows up in the feed, marked failed, so nothing is silently dropped.
6. They point a **Scheduled job** at `cron 0 3 * * *` running a backup image,
   and subscribe their own URL to swarmy's **outbound webhooks** so their pager
   hears about `workflow-failed` the moment it happens.

No external queue provider, no CI runner for a nightly task, no webhook relay.
The work runs on the nodes they already pay for, against the cache clusters
swarmy already manages, and every mutation is org-scoped and audited.

## How it works (the automation path)

```
 dashboard: stack → Messaging tab                        third parties
   │  Attach queue · Build workflow · Add endpoint · Add job │  POST /hooks/i/<org>/<slug>
   ▼                                                         ▼
 tRPC mutation (orgProcedure, audited)                 public receiver (apps/api)
   │  label write  |  DB row                             verify hmac/github/stripe
   │  (queue def)  | (job/workflow/endpoint)             persist InboundDelivery
   ▼               ▼                                          │
 ┌──────────────────────────────────────────────┐           │ PENDING, due now
 │ controller worker loops (apps/api/src/workers)│◄──────────┘
 │  queue-reconcile   depth sample → service.scale, stamp stats label
 │  job-scheduler     cron due → container.runOnce / exec  → JobRun
 │  workflow-runner   advance cursor: container/exec/webhook/approval/delay
 │  inbound-dispatch  deliver to queue (RPUSH) or forward (POST), retry→DEAD
 │  webhook-dispatch  swarmy event → signed POST to your URLs, retry→failed
 └──────────────────────────────────────────────┘
   │  ctx.hub.dispatch(nodeId, cmd, payload)  — the ONLY way work reaches a node
   ▼
 agent runs it against the LOCAL Docker socket (runOnce / exec on a container)
```

Four ideas, one story:

- **The controller decides; the worker loops; the agent executes.** Every piece
  of automation is a controller-side tick (5–15s) that reads live state, decides
  one thing, and either writes a Docker label, writes a history row, or
  `hub.dispatch`es a command to a node. swarmy never opens a redis port, never
  reaches a node's socket — it exec's `redis-cli` *inside* the cache primary's
  own container and runs one-shot jobs as real swarm tasks. See the
  `reconcile-workers` skill for the loop shape and `agent-handlers` for dispatch.
- **A queue is a convention over the cache you already run.** There is no queue
  server to provision. A queue is a row in the `swarmy.queues` JSON label on a
  worker service, pointed at a managed cache cluster; depth is `LLEN`/`ZCARD`
  read live, and autoscale is `service.scale` between `minWorkers` and
  `maxWorkers`. BullMQ and raw-list are both first-class; the dead-letter list
  is one swarmy convention (`<q>:dead`) for both.
- **Workflows and jobs are the DB's to keep, because they are history.** A
  `WorkflowDef` is the user's *input artifact* (like a stack's compose source); a
  `WorkflowRun`/`WorkflowStepRun` and a `JobRun` are *queryable run history*.
  That is exactly what swarmy's DB is for. Nothing about live swarm state is
  mirrored — step targets resolve from live inventory at execution time.
- **Every side effect is one signature.** Inbound HMAC/GitHub/Stripe verify,
  workflow webhook steps, and outbound event delivery all use the same
  `sha256=<hmac>` scheme over the raw body; secrets are vault-encrypted at rest
  and decrypted just-in-time, never returned to a client.

## Roles and where truth lives

- **Queue definitions are Docker truth** — one `swarmy.queues` JSON label on the
  *worker* service (`[{name, cacheCluster, convention, scalePerJobs, minWorkers,
  maxWorkers, retries, dlq}]`). The last depth sample is stamped into a
  `swarmy.queues.stats` label by `queue-reconcile` so the list renders without an
  exec fan-out. No queue row in Postgres — see the `docker-native-storage` skill.
- **Queue contents live in the cache cluster, never swarmy.** Waiting/active/
  failed/delayed and the `<q>:dead` list are keys in the org's own Valkey/Redis
  primary. swarmy reads and mutates them by exec'ing the CLI inside that
  container (the password is read from the mounted secret file, never on the
  wire).
- **Scheduled jobs, workflows and their runs are swarmy's DB** — `ScheduledJob`/
  `JobRun`, `WorkflowDef`/`WorkflowRun`/`WorkflowStepRun`. These are identity +
  input + audited history, not swarm state, so Postgres is the right home.
  `stackName` on each is the stack-scoped-IA home; `null` = org-wide/legacy.
- **Inbound and outbound webhook plumbing is swarmy's DB** — `InboundEndpoint`/
  `InboundDelivery` and `WebhookEndpoint`/`WebhookDelivery`. Verify secrets and
  outbound signing secrets are stored `…SecretEnc` (vault-encrypted); captured
  request headers redact `authorization`/`cookie`.
- **What a job/step actually runs is resolved live.** An image job dispatches
  `container.runOnce`; a service-exec job/step resolves a running task container
  from the hub's live inventory and dispatches `exec`. The controller holds the
  history row; the node holds the truth of the run.

## Automation behaviour (what the promise commits us to)

- **Queues autoscale, and only within the operator's band.** Desired workers is
  `clamp(ceil(wait / scalePerJobs), minWorkers, maxWorkers)`. `minWorkers: 0`
  legitimately scales a queue's workers to zero when idle; the band is never
  exceeded.
- **Dead letters are a first-class, browsable place.** Exhausted jobs RPUSH to
  `<q>:dead` for both conventions; the UI browses the tail and requeues bounded
  batches back onto `wait`. Draining deletes waiting (+ delayed) jobs but never
  touches active or dead.
- **Workflows are versioned; runs are pinned.** Editing a workflow writes a *new*
  version row — history and any in-flight run's pinned steps stay intact. Steps
  are sequential (v1): `container`, `service-exec`, `webhook`, `approval`
  (parks as `WAITING_APPROVAL` until a mutation approves/rejects — audited with
  the actor), `delay` (parks on `nextEligibleAt`). Per-step timeout + retries
  with exponential backoff; a step that fails after its budget fails the run and
  fires a `workflow-failed` event.
- **Runs advance under an optimistic claim.** The runner guards every write on
  `status: RUNNING` + the old cursor, so a concurrent cancel or approve makes the
  step's completion a safe no-op. A 10-minute container never blocks the 5s tick
  — advancement is detached.
- **Inbound deliveries are persisted before they are trusted.** The receiver
  caps the body at 256KB, verifies per `verifyKind`, and stores the delivery
  either way (verified → PENDING + due now; failed → FAILED, kept for the feed).
  Delivery to a queue target is `RPUSH` (list) or a best-effort BullMQ insert;
  forward targets POST to a controller-reachable URL. Retries walk
  1m/5m/15m/1h/6h, then DEAD. Replay just resets a row to PENDING + due-now.
- **Scheduled jobs are cron the operator can read.** A 5-field cron, previewed
  live ("next N occurrences") before save; a job fires a one-shot container or a
  service exec, records a `JobRun` with an output tail, and `alertOnFailure`
  raises an alert event. Pause keeps the job; runNow fires immediately.
- **Outbound webhooks fan swarmy's own events out.** An endpoint subscribes to
  event types (or `*`); `webhook-dispatch` POSTs each with an HMAC signature and
  retries with backoff. `test` enqueues a `ping` so wiring is provable end-to-end.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| Cache primary down when reading depth | `queueStats` falls back to the last `swarmy.queues.stats` label stamp; the list still renders. Actions that must exec return a clear "no running container" rejection rather than a hang. |
| Worker service backlog spikes | `queue-reconcile` scales replicas up to `maxWorkers`; when the backlog clears it scales back to `minWorkers` (possibly 0). Never exceeds the band. |
| Third-party webhook with a bad signature | Persisted as `FAILED` (kept for the audit feed) and answered `401`; never enqueued. Verifying kinds fail closed if the secret can't be decrypted. |
| Inbound target unreachable | Delivery retries 1m→6h across 6 attempts, then `DEAD`. A malformed endpoint target dead-letters immediately (not retryable). Replay re-runs the transform on the original body. |
| Workflow step times out or errors | Retries per the step's budget with backoff; exhausted → step fails → run fails → `workflow-failed` event. The agent still kills the container at its `timeoutMs`. |
| Run cancelled mid-step | The runner's next guarded write is a no-op (claim lost); the step is marked cancelled. Best-effort: the container is killed at its timeout. |
| No online node to run a job/step | The attempt fails with "no online node"; a scheduled job records the failed `JobRun` and, with `alertOnFailure`, raises an alert. |
| Controller restarts mid-run | State lives in Postgres (cursor, stateJson) + the cache; the next tick re-claims RUNNING runs and PENDING deliveries and continues. No work is lost, none double-commits (guarded writes). |

## Explicitly rejected

- **A bundled queue/broker service (RabbitMQ, a swarmy-run Redis-for-queues).**
  swarmy already provisions managed cache clusters; a queue is a convention over
  one, so there is nothing new to run, secure, or back up. See
  `docker-native-storage`.
- **A queue table in Postgres.** Queue *definitions* are Docker labels and queue
  *contents* are cache keys. A DB mirror would drift from both and duplicate the
  cache's job store. The DB holds only run history, which the cache does not.
- **The controller opening a redis/AMQP port to a node.** All queue reads and
  mutations exec the CLI *inside* the cache primary's own container via the
  agent — same dial-out rule as everything else (`agent-handlers`). No inbound
  port, no password on the wire.
- **A general DAG / parallel-branch workflow engine (v1).** Steps are sequential
  and pinned per run; approvals and delays cover the human-in-the-loop and
  timing cases without a scheduler-of-schedulers. Parallelism is a later,
  deliberate extension, not an accident of v1.
- **Forwarding inbound webhooks anywhere the payload names.** Forward targets are
  operator-configured `http(s)` URLs the controller can reach; in-cluster
  consumers use a queue target. swarmy never POSTs to a URL that arrived inside
  the request body.
- **Returning any secret to the client.** Verify secrets, webhook-step secrets,
  and outbound signing secrets are write-only: stored `…SecretEnc`, surfaced only
  as a `hasSecret` presence flag.

## Implementation map

The worker-loop conventions (tick cadence, optimistic claims, "mirror the pure
helpers, never subpath-import an internal trpc module") live in the
`reconcile-workers` skill; how a mutation reaches a node lives in
`agent-handlers`; where each piece of config belongs lives in
`docker-native-storage`; the cross-stack slice shape is `add-feature-slice`.

Real code homes:

- **Queues** — `packages/trpc/src/routers/queues.ts`,
  `packages/trpc/src/services/queues.service.ts` (label codecs, redis command
  builders, exec-on-primary), worker
  `apps/api/src/workers/queue-reconcile.ts`.
- **Scheduled jobs** — `packages/trpc/src/routers/jobs.ts`,
  `packages/trpc/src/services/jobs.service.ts` (+ cron in
  `packages/trpc/src/services/schedule.ts`), worker
  `apps/api/src/workers/job-scheduler.ts`; models in
  `packages/db/prisma/schema/jobs.prisma`
  (`ScheduledJob`/`JobRun`); the `container.runOnce` command in
  `packages/core/src/protocol/swarmres.ts`.
- **Workflows** — `packages/trpc/src/routers/workflows.ts`,
  `packages/trpc/src/services/workflows.service.ts` (steps codec, approve/reject
  transitions), worker `apps/api/src/workers/workflow-runner.ts` (the pure
  `advanceState` reducer); models `WorkflowDef`/`WorkflowRun`/`WorkflowStepRun`
  in `packages/db/prisma/schema/jobs.prisma`.
- **Inbound webhooks** — public receiver `apps/api/src/inbound-hooks.ts` (mounted
  at `/hooks`) + `apps/api/src/inbound-template.ts`, router
  `packages/trpc/src/routers/inboundWebhooks.ts`, service
  `packages/trpc/src/services/inboundWebhooks.service.ts`, worker
  `apps/api/src/workers/inbound-webhook-dispatch.ts`; models
  `InboundEndpoint`/`InboundDelivery` in
  `packages/db/prisma/schema/webhooks.prisma`.
- **Outbound webhooks** — router `packages/trpc/src/routers/webhooksOut.ts`,
  service `packages/trpc/src/services/webhooks-out.service.ts`, worker
  `apps/api/src/workers/webhook-dispatch.ts`; models
  `WebhookEndpoint`/`WebhookDelivery` in `packages/db/prisma/schema/api.prisma`.
- **UI** — the stack workspace **Messaging** tab
  (`apps/app/src/routes/_authed/stacks/$name.messaging.tsx`) composes
  `stack-queues-section`, `stack-workflows-section`, `stack-webhooks-section` and
  `stack-jobs-section` under `apps/app/src/components/{queues,workflows,webhookgw,jobs}/`;
  the org-level `/queues`, `/jobs`, `/workflows`, `/webhooks` routes now redirect
  into the stack workspace, and a run's timeline lives at
  `apps/app/src/routes/_authed/workflows.$runId.tsx`.
