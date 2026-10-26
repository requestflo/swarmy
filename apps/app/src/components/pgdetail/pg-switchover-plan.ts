import { SWITCHOVER_BUSY, planSwitchover, type SwitchoverPlan } from '@swarmy/core';

/**
 * "Make this copy the writer" (board 39) and dragging the writer on the Data
 * page (board 15) ask the SAME pure plan the controller runs before it
 * touches anything (@swarmy/core `planSwitchover`), on the same three reads:
 * `db.get` (the copies), `db.replication` (each standby's state and bytes
 * behind) and `db.pooler` (which apps go straight to the main copy, so
 * restart onto the new writer). The
 * dashboard never has its own copy of the rule. PURE — tested in
 * pg-switchover.test.ts.
 */

export interface PgSwitchoverFacts {
  cluster: {
    name: string;
    topology: string;
    members: ReadonlyArray<{ service: string; role: string; desired: number; running: number }>;
    /** A held failover (`db.get`'s pendingFailover). */
    pendingFailover?: unknown;
  };
  /** `db.replication`'s rows; null until read. */
  standbys: ReadonlyArray<{ service: string | null; nodeId: string | null; state: string | null; lagBytes: number | null }> | null;
  /** `db.pooler`'s wired apps; null until read. */
  apps: ReadonlyArray<{ service: string; via: string }> | null;
  /** A switchover of this cluster is running now. */
  running: boolean;
  copyName: (service: string) => string;
}

/** Who may take the writes (`target`, or the most caught-up copy), or why not; null until the reads are in. */
export function planCopy(f: PgSwitchoverFacts, target?: string): SwitchoverPlan | null {
  if (!f.standbys || !f.apps) return null;
  const busy = f.cluster.pendingFailover ? SWITCHOVER_BUSY.held : f.running ? SWITCHOVER_BUSY.running : null;
  return planSwitchover({
    cluster: f.cluster.name,
    topology: f.cluster.topology,
    members: f.cluster.members,
    standbys: f.standbys,
    busy,
    directApps: f.apps.filter((a) => a.via !== 'pooler').map((a) => a.service).sort(),
    ...(target ? { target } : {}),
    copyName: f.copyName,
  });
}

/** "wkr-2's copy" — the copy by the server it runs on ("mgr-1 and wkr-1's copies" for a service with two). */
export function copyNameOf(service: string, servers: ReadonlyArray<{ name: string }> | undefined, short: (s: string) => string): string {
  const hosts = (servers ?? []).map((n) => n.name);
  if (hosts.length === 0) return short(service);
  return hosts.length === 1 ? `${hosts[0]}'s copy` : `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}'s copies`;
}
