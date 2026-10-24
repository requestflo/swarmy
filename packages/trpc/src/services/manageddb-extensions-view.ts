import {
  DB_EXTENSIONS_ERROR_LABEL,
  PG_EXTENSION_CATALOG,
  PG_EXTENSION_NAMES,
  dbStorageState,
  extLabelsOf,
  extMemberOf,
  parseExtError,
  planPgExtensions,
  type ExtStep,
  type PgExtensionName,
} from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { availableOf, liveCluster } from './manageddb-extensions.service';

/**
 * `db.extensions` — one managed Postgres's extensions, read off the primary's
 * labels + every member's env, with the SAME plan the reconcile runs saying
 * what is happening now (standbys restarting, the main copy restarting, ...).
 */

export interface PgExtensionView {
  name: PgExtensionName;
  /** CREATE EXTENSION has run on the main copy. */
  on: boolean;
  /** Asked for (the declared label). */
  wanted: boolean;
  /** The image ships it; null until the reconcile has checked this image. */
  available: boolean | null;
  /** Turning it on or off restarts every copy (shared_preload_libraries). */
  restartsCopies: boolean;
  canDisable: boolean;
}

export interface PgExtensionsView {
  stack: string;
  cluster: string;
  image: string;
  /** Copies that restart for a preload change (standbys first, then the main copy). */
  copies: number;
  extensions: PgExtensionView[];
  /** What the reconcile is doing now; null when settled. */
  progress: { kind: Exclude<ExtStep['kind'], 'steady'>; phase: 'standby' | 'writer' | null; services: string[]; reason: string | null } | null;
  error: string | null;
}

export function getDbExtensions(ctx: OrgContext, input: { stack: string; cluster: string }): PgExtensionsView {
  const live = liveCluster(ctx, input.stack, input.cluster);
  const { primary } = live;
  const labels = extLabelsOf(primary);
  const available = availableOf(primary);
  // The dashboard never sees a SHOW answer: a member that is running and not
  // mid-update counts as back (the worker verifies before moving on).
  const back = (s: SwarmServiceInfo) => (s.runningReplicas ?? 0) >= (s.desiredReplicas ?? 1);
  const step = planPgExtensions({
    ...labels,
    primaryRunning: (primary.runningReplicas ?? 0) > 0,
    writersRedeployable: dbStorageState(primary).state === 'persistent',
    members: [
      extMemberOf(primary, 'writer', back(primary)),
      ...live.writers.map((s) => extMemberOf(s, 'writer', back(s))),
      ...live.standbys.map((s) => extMemberOf(s, 'standby', back(s))),
    ],
  });
  return {
    stack: input.stack,
    cluster: input.cluster,
    image: primary.image,
    copies: 1 + live.writers.length + live.standbys.reduce((n, s) => n + (s.desiredReplicas ?? 0), 0),
    extensions: PG_EXTENSION_NAMES.map((name) => ({
      name,
      on: labels.applied.includes(name),
      wanted: labels.wanted.includes(name),
      available: available === null ? (PG_EXTENSION_CATALOG[name].contrib ? true : null) : available.includes(name),
      restartsCopies: PG_EXTENSION_CATALOG[name].preload !== null,
      canDisable: PG_EXTENSION_CATALOG[name].canDisable,
    })),
    progress:
      step.kind === 'steady'
        ? null
        : {
            kind: step.kind,
            phase: 'phase' in step ? step.phase : null,
            services: 'services' in step ? step.services : [],
            reason: step.kind === 'blocked' ? step.reason : null,
          },
    error: parseExtError(primary.labels[DB_EXTENSIONS_ERROR_LABEL])?.message ?? null,
  };
}

