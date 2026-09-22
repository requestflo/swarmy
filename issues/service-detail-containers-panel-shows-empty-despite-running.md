# A newly-deployed service's detail page shows "0 / Nothing running yet" in the Containers panel even while the service is genuinely running

**Status:** Fixed (2026-09) — root-caused via source, see "Fix applied" below. Previously: reproduced live, not root-caused (not investigated beyond
confirming it's UI-only). Not fixed this session (per standing "document, don't patch"
directive).
**Severity:** Minor/UX — does not block the underlying feature (the service is genuinely
deployed and reachable; this is purely a dashboard display gap), but directly undermines user
trust at exactly the moment a user most wants reassurance that their deploy worked.

## Symptom

Deployed a new service (`s3mock`, image `adobe/s3mock:latest`, port 9090) via the real "Ship a
service" custom-deploy form. The deploy succeeded — the service detail page's top summary cards
correctly showed **"1/1 RUNNING"** and **"Last Ship: Complete"** — but the same page's
**"Containers" panel simultaneously showed "0 / Nothing running yet"**, as if no containers
existed at all. Two panels on the identical page, reading from (presumably) the same underlying
deploy, disagreeing with each other.

Verified this was a pure display bug, not a real deploy failure, via direct node inspection:

```
$ docker ps
s3mock.1.tm8abaskxy7406zli6ingawsk   adobe/s3mock:latest   Up ...
$ docker service ls
... s3mock   replicated   1/1   adobe/s3mock:latest   *:9090->9090/tcp
```

The container is genuinely running, 1/1 replicas, with its port correctly published through the
routing mesh. The underlying deployment is entirely correct — only the Containers panel's own
data/rendering is wrong.

## Why this matters

The Containers panel is exactly the place a user checking "did my deploy actually work" would
look for concrete confirmation (container ID, uptime, resource usage) beyond a bare "1/1"
counter. Seeing "Nothing running yet" right next to "RUNNING" and "Complete" reads as a
contradiction a normal user has no way to resolve without dropping into `docker ps` themselves —
directly against the governing directive's "magical, no babysitting" bar, and specifically
undermining confidence at the moment right after a deploy when reassurance matters most.

## Not yet tested

Whether this is specific to services deployed via the custom "Ship a service" form (as opposed to
blueprint-deployed stacks, which have not shown this symptom in this sweep — e.g. `littleworld`'s
containers render correctly), a timing/cache-staleness issue (does it resolve itself after a
longer wait or a hard refresh?), or a fresh-org/fresh-service-only condition. Not yet root-caused
via source — the actual query/component backing the Containers panel hasn't been located yet.

## Fix applied (2026-09)

**Root cause (source):** the Containers panel reads from the same `inventory.get` poll as the
canvas via `useServiceContainers(serviceId)`
(`apps/app/src/components/services/use-service-containers.ts`), which matched inventory services
strictly by Docker service **id**. But the "Ship a service" form navigates to the id returned by
`services.create`, which is the service **name** whenever the live inventory hasn't caught up yet
(`packages/trpc/src/services/service.service.ts`: `liveService(ctx, input.name)?.id ?? input.name`).
The hero/summary cards use `services.get`, whose server-side `liveService()` resolves by id *or*
name, so they were correct while the containers hook found nothing and returned `[]` →
"0 / Nothing running yet". Blueprint-deployed stacks link with the real Docker id, which is why
they never showed the symptom.

**Fix:** `useServiceContainers` now resolves by id or name, mirroring the server lookup. No
polling, scoping or task-vs-container filtering was at fault.

**Status:** Fixed — root-caused via source; pending a live re-check on a fresh custom deploy.
