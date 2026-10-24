/**
 * Resilience check `controller-store`: is swarmy's own store (control.db)
 * on one server only, or replicated with a lag worth worrying about?
 * PURE over a signal picked off the controller store view, so runChecks can
 * classify it without a ctx (backups-dr invariant 9).
 */
import type { ResilienceProblemView } from '@swarmy/core';
import type { ControllerStoreView } from './controllerStore.view';

export interface ControllerStoreSignal {
  mode: ControllerStoreView['mode'];
  replicating: boolean;
  lagSeconds: number | null;
  problem: string | null;
  /** "controller store: local only" / "controller store: replicated (lag Ns)". */
  summary: string;
  hostname: string;
}

export function controllerStoreSignal(v: ControllerStoreView): ControllerStoreSignal {
  return { mode: v.mode, replicating: v.replicating, lagSeconds: v.lagSeconds, problem: v.problem, summary: v.summary, hostname: v.hostname };
}

const FIX = { fixPath: '/backups', resource: 'controller store' } as const;

/**
 * `managers` = swarm managers. With two or more, a replicated store also lets
 * the controller restart on another manager, so a local-only one is a warn.
 * A null signal (no store runtime in this process) raises nothing.
 */
export function controllerStoreProblems(sig: ControllerStoreSignal | null | undefined, managers: number): ResilienceProblemView[] {
  if (!sig) return [];
  if (sig.mode === 'local-only') {
    const canFloat = managers >= 2;
    return [
      {
        id: 'controller-store',
        check: 'controller-store',
        severity: canFloat ? 'warn' : 'info',
        title: "swarmy's own store is on one server",
        detail: `${sig.summary}. If ${sig.hostname} is lost, everything since the last controller backup goes with it${
          canFloat ? ', and the controller cannot restart on another manager until it is rebuilt from that backup' : ''
        }.`,
        fixHint: 'Turn on continuous replication (swarmy object storage or an S3 destination) under Backups → swarmy itself.',
        fixLabel: 'Turn on replication',
        ...FIX,
      },
    ];
  }
  if (!sig.problem) return [];
  return [
    {
      id: 'controller-store',
      check: 'controller-store',
      severity: 'warn',
      title: "Replication of swarmy's own store needs a look",
      detail: `${sig.summary}: ${sig.problem}. Writes the replica doesn't hold yet are lost if ${sig.hostname} dies now.`,
      fixHint: 'Check that object storage is reachable from the controller, then look at the replication card under Backups → swarmy itself.',
      fixLabel: 'Check replication',
      ...FIX,
    },
  ];
}
