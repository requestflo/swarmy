/**
 * PURE — what removing a cloned environment takes away and what it keeps
 * (remove-env.ts runs it). Read off Docker truth before anything goes: the
 * stack's live app services (their routes and named volumes), with the plan's
 * ledger and desired state for what never ran.
 *
 * The data choice follows stack removal: `delete` deletes its databases and
 * named volumes on every server; `keep` (the default) leaves its databases
 * running with their backups and its volumes on the servers, and marks what
 * it kept as orphaned so a GC (or a person) can find it later. Docker fixes a
 * volume's labels when it is created, so the mark is a small labelled Docker
 * config naming them (`orphanMarker`), never a database row.
 */
import type { DesiredApp } from '@swarmy/app-config';
import { readRoutes } from '../ingress-routes';
import { APP_STACK_LABEL, type AppLedger } from './live';

export type DataChoice = 'keep' | 'delete';

/** A live service as the plan reads it (a `SwarmServiceInfo` subset). */
export interface LiveEnvService {
  name: string;
  labels: Record<string, string>;
  mounts?: ReadonlyArray<{ type?: string; source?: string }>;
}

export interface EnvRemovalInput {
  stack: string;
  data: DataChoice;
  desired: Pick<DesiredApp, 'services' | 'resources'>;
  ledger: Pick<AppLedger, 'resources' | 'jobs' | 'connect' | 'kept'>;
  /** Every live service of the org (only this stack's app services count). */
  live: readonly LiveEnvService[];
  /** The environment's own secret families (`<x>.<env>`, its marker's slots). */
  secretFamilies: readonly string[];
}

export interface EnvRemovalPlan {
  remove: {
    /** App services (`shop-qa_web`). */
    services: string[];
    jobs: string[];
    /** "Connect apps" peers it is linked to. */
    links: string[];
    /** Its own caches, search, vectors and buckets (throwaway: always go). */
    resources: string[];
    /** Postgres deleted with its data (`delete` only). */
    databases: string[];
    /** Named volumes deleted on every server (`delete` only). */
    volumes: string[];
    secrets: string[];
    /** Addresses that stop answering (the live route labels of its services). */
    hosts: string[];
  };
  keep: { databases: string[]; volumes: string[] };
}

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

export function planEnvRemoval(input: EnvRemovalInput): EnvRemovalPlan {
  const { stack, ledger, desired } = input;
  const app = input.live.filter((s) => s.labels[APP_STACK_LABEL] === stack);
  const resources = [...desired.resources, ...Object.values(ledger.resources)];
  const databases = sorted(resources.filter((r) => r.type === 'postgres').map((r) => r.name));
  const volumes = sorted([
    ...app.flatMap((s) => (s.mounts ?? []).filter((m) => (m.type ?? 'volume') === 'volume' && m.source).map((m) => m.source!)),
    ...desired.services.flatMap((s) => s.volumes.map((v) => v.volumeName)),
    // Postgres swarmy.yaml already removed whose data it kept (until purged).
    ...Object.values(ledger.kept ?? {}).flat(),
  ]);
  const del = input.data === 'delete';
  return {
    remove: {
      services: sorted(app.map((s) => s.name)),
      jobs: sorted(Object.keys(ledger.jobs)),
      links: sorted(ledger.connect),
      resources: sorted(Object.entries(ledger.resources).filter(([, r]) => r.type !== 'postgres').map(([n]) => n)),
      databases: del ? databases : [],
      volumes: del ? volumes : [],
      secrets: sorted(input.secretFamilies),
      hosts: sorted(app.flatMap((s) => readRoutes(s.labels).map((r) => r.host))),
    },
    keep: { databases: del ? [] : databases, volumes: del ? [] : volumes },
  };
}

/** The label a GC finds left-over data by; its value says who left it. */
export const ORPHANED_LABEL = 'swarmy.orphaned';

export interface OrphanMarker {
  name: string;
  labels: Record<string, string>;
  /** What was kept: `{ stack, environment, volumes, databases }` as JSON. */
  data: string;
}

/**
 * The orphan mark for what an environment removal kept, or null when it kept
 * nothing. `nonce` keeps the config name unique when a name is cloned and
 * removed again.
 */
export function orphanMarker(
  orgId: string,
  stack: string,
  environment: string,
  keep: EnvRemovalPlan['keep'],
  nonce: string,
): OrphanMarker | null {
  if (!keep.volumes.length && !keep.databases.length) return null;
  return {
    name: `swarmy-orphaned.${stack}.${nonce}`.slice(0, 64),
    labels: {
      [ORPHANED_LABEL]: 'app.environment.remove',
      [`${ORPHANED_LABEL}.org`]: orgId,
      [`${ORPHANED_LABEL}.stack`]: stack,
      [`${ORPHANED_LABEL}.environment`]: environment,
    },
    data: JSON.stringify({ stack, environment, volumes: keep.volumes, databases: keep.databases }),
  };
}
