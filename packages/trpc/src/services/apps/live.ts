/**
 * The git-apps LEDGER and the LiveApp reader (pure).
 *
 * The ledger is swarmy's record of what it has applied for one app
 * environment — per unit, the signature (and for resources the applied spec)
 * of the last successful apply. It is history, persisted on the AppPlan row
 * that produced it; it never decides what exists.
 *
 * What EXISTS is Docker truth: `readLiveApp` intersects the ledger with the
 * live inventory. An app service is one carrying `swarmy.app.stack=<stack>`
 * (stamped by the apply loop), so hand-made services in the same stack are
 * never touched. A managed resource exists when its service does (bucket and
 * pgvector have no service of their own — the ledger is their record). A
 * resource that exists live but is not in the ledger is surfaced WITHOUT a
 * signature, so the planner asks a human before taking it over.
 */
import type {
  DesiredApp,
  DesiredResource,
  DesiredService,
  LiveApp,
  PlanAction,
  ResourceType,
} from '@swarmy/app-config';
import { primaryDataVolumeName, replicaDataVolumeName } from '@swarmy/core';
import { primaryServiceName, walArchiveVolumeName } from '../manageddb.service';
import { cachePrimaryName } from '../cache.service';
import { searchServiceName } from '../search.service';
import { vectorServiceName } from '../vector.service';

export const APP_STACK_LABEL = 'swarmy.app.stack';
export const APP_SERVICE_LABEL = 'swarmy.app.service';
export const APP_SIG_LABEL = 'swarmy.app.sig';
export const APP_BUILD_LABEL = 'swarmy.app.build';
export const APP_COMMIT_LABEL = 'swarmy.app.commit';
export const APP_ENV_LABEL = 'swarmy.app.environment';

export interface AppLedger {
  services: Record<
    string,
    { sig: string; buildKey?: string; image: string; volumes: string[]; applied?: DesiredService }
  >;
  resources: Record<string, DesiredResource & { bucketId?: string }>;
  routes: Record<string, { sig: string; service: string; host: string; path: string }>;
  jobs: Record<string, { sig: string; jobId: string }>;
  connect: string[];
  /** Attachments done per service (`db:DATABASE_URL`, `cache:REDIS_URL`, `secret:stripe-key`…). */
  attached: Record<string, string[]>;
  /** Removed Postgres clusters whose data volumes swarmy deliberately KEPT (until purged). */
  kept?: Record<string, string[]>;
}

export const emptyLedger = (): AppLedger => ({
  kept: {},
  services: {},
  resources: {},
  routes: {},
  jobs: {},
  connect: [],
  attached: {},
});

export function parseLedger(json: unknown): AppLedger {
  const base = emptyLedger();
  if (!json || typeof json !== 'object') return base;
  const j = json as Partial<AppLedger>;
  return {
    services: j.services ?? {},
    resources: j.resources ?? {},
    routes: j.routes ?? {},
    jobs: j.jobs ?? {},
    connect: j.connect ?? [],
    attached: j.attached ?? {},
    kept: j.kept ?? {},
  };
}

/** Minimal live-service shape (an InvService subset). */
export interface LiveServiceLike {
  name: string;
  image: string;
  labels: Record<string, string>;
}

/** The swarm service that proves a managed resource exists (null = no service of its own). */
export function resourceServiceName(
  stack: string,
  r: { name: string; type: ResourceType; engine?: string },
): string | null {
  switch (r.type) {
    case 'postgres':
      return primaryServiceName(stack, r.name);
    case 'cache':
      return cachePrimaryName(stack, r.name);
    case 'search':
      return searchServiceName(stack, r.name);
    case 'vector':
      return r.engine === 'pgvector' ? null : vectorServiceName(stack, r.name);
    case 'bucket':
      return null;
  }
}

export function readLiveApp(input: {
  stack: string;
  services: LiveServiceLike[];
  ledger: AppLedger;
  /** Names of scheduled jobs that exist (DB). */
  jobNames: Set<string>;
  /** Resources the live inventory proves exist even if the ledger doesn't know them (adoption). */
  desiredResources?: DesiredResource[];
}): LiveApp {
  const { stack, ledger } = input;
  const byName = new Map(input.services.map((s) => [s.name, s]));

  const services: LiveApp['services'] = [];
  for (const s of input.services) {
    if (s.labels[APP_STACK_LABEL] !== stack) continue;
    const short = s.labels[APP_SERVICE_LABEL] ?? s.name.replace(`${stack}_`, '');
    const led = ledger.services[short];
    services.push({
      name: short,
      image: s.image,
      // The label is what the running spec was deployed with; the ledger is the fallback.
      ...((s.labels[APP_SIG_LABEL] ?? led?.sig)
        ? { sig: s.labels[APP_SIG_LABEL] ?? led?.sig }
        : {}),
      ...((s.labels[APP_BUILD_LABEL] ?? led?.buildKey)
        ? { buildKey: s.labels[APP_BUILD_LABEL] ?? led?.buildKey }
        : {}),
      volumes: led?.volumes ?? [],
      ...(led?.applied ? { applied: led.applied } : {}),
    });
  }

  const resources: LiveApp['resources'] = [];
  const seen = new Set<string>();
  for (const [name, r] of Object.entries(ledger.resources)) {
    const svc = resourceServiceName(stack, r);
    if (svc !== null && !byName.has(svc)) continue; // ledger says so, Docker says gone → missing
    const { bucketId: _b, ...applied } = r;
    resources.push({ name, type: r.type, sig: r.sig, applied: applied as DesiredResource });
    seen.add(name);
  }
  for (const d of input.desiredResources ?? []) {
    if (seen.has(d.name)) continue;
    const svc = resourceServiceName(stack, d);
    if (svc && byName.has(svc)) resources.push({ name: d.name, type: d.type }); // adoption: no sig
  }

  return {
    stack,
    services: services.sort((a, b) => (a.name < b.name ? -1 : 1)),
    resources,
    routes: Object.values(ledger.routes).map((r) => ({
      host: r.host,
      path: r.path,
      service: r.service,
      sig: r.sig,
    })),
    jobs: Object.entries(ledger.jobs)
      .filter(([name]) => input.jobNames.has(name))
      .map(([name, j]) => ({ name, sig: j.sig })),
    connect: [...ledger.connect],
  };
}

/** Fold one successful action into the ledger (pure; returns a new ledger). */
export function ledgerAfter(
  ledger: AppLedger,
  desired: DesiredApp,
  action: PlanAction,
  result: { image?: string; jobId?: string; bucketId?: string } = {},
): AppLedger {
  const next: AppLedger = structuredClone(ledger);
  switch (action.kind) {
    case 'resource.create':
    case 'resource.update':
      next.resources[action.name] = {
        ...action.resource,
        ...(result.bucketId ? { bucketId: result.bucketId } : {}),
      };
      if (
        action.kind === 'resource.update' &&
        ledger.resources[action.name]?.bucketId &&
        !result.bucketId
      ) {
        next.resources[action.name]!.bucketId = ledger.resources[action.name]!.bucketId;
      }
      break;
    case 'resource.delete':
      if (action.resourceType === 'postgres') {
        // The cluster stops; its data stays until an explicit purge.
        next.kept = {
          ...(next.kept ?? {}),
          [action.name]: [
            primaryDataVolumeName(desired.stack, action.name),
            replicaDataVolumeName(desired.stack, action.name),
            walArchiveVolumeName(desired.stack, action.name),
          ],
        };
      }
      delete next.resources[action.name];
      break;
    case 'service.deploy': {
      const s = action.service;
      next.services[s.name] = {
        sig: s.sig,
        ...(s.source.kind === 'build' ? { buildKey: s.source.key } : {}),
        image: result.image ?? ('image' in action.image ? action.image.image : ''),
        volumes: s.volumes.map((v) => v.name),
        applied: s,
      };
      break;
    }
    case 'service.remove':
      delete next.services[action.name];
      delete next.attached[action.name];
      break;
    case 'route.add':
    case 'route.update': {
      const key =
        action.route.path === '/' ? action.route.host : `${action.route.host}${action.route.path}`;
      next.routes[key] = {
        sig: action.route.sig,
        service: action.route.service,
        host: action.route.host,
        path: action.route.path,
      };
      break;
    }
    case 'route.remove':
      delete next.routes[action.path === '/' ? action.host : `${action.host}${action.path}`];
      break;
    case 'job.create':
    case 'job.update':
      next.jobs[action.name] = {
        sig: action.job.sig,
        jobId: result.jobId ?? ledger.jobs[action.name]?.jobId ?? '',
      };
      break;
    case 'job.remove':
      delete next.jobs[action.name];
      break;
    case 'link.add':
      next.connect = [...new Set([...next.connect, action.peer])].sort();
      break;
    case 'link.remove':
      next.connect = next.connect.filter((p) => p !== action.peer);
      break;
    case 'build':
      break;
  }
  void desired;
  return next;
}
