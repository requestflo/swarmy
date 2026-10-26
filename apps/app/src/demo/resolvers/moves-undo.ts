import type { MoveState, MoveStep } from '@swarmy/core';
import { MOVE_UNDO_WINDOW_HOURS, OLD_COPY_KEEP_DAYS } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { moves, oldCopies } from './moves';

/**
 * Demo Undo of a move (board 9): `decommission.undoMove` and the old copies a
 * server keeps (`decommission.oldCopies`, with `undoUntil` for 24 hours).
 * Like the real rule, Undo copies nothing and refuses when a copy changed:
 * the demo's Postgres writes all the time, so its Undo is refused in the
 * real words; anything else goes back onto its old copy in a few seconds,
 * through the same `swarmy.move.state` steps the real one takes.
 */

const WINDOW_MS = MOVE_UNDO_WINDOW_HOURS * 3_600_000;
/** Services that wrote on the new server since the move (a database never sits still). */
const WRITES = new Set(['svc-postgres']);
const STEPS: [MoveStep, number][] = [
  ['stop', 0],
  ['verify', 2],
  ['repin', 4],
  ['start', 5],
];
const DONE_AT_S = 7;

const nameOf = (store: DemoStore, id: string): string => store.nodes.find((n) => n.id === id)?.name ?? id;

export const movesUndoDemo: DomainResolvers = {
  handlers: {
    'decommission.undoMove': (i, store) => {
      const { service } = i as { service: string };
      const sv = store.services.find((s) => s.name === service);
      if (!sv) throw new Error(`no service named ${service}`);
      const kept = oldCopies(store)[sv.id];
      if (moves(store)[sv.id]) throw new Error(`${service} is already moving.`);
      if (!kept) throw new Error(`There is no move of ${service} to undo: swarmy keeps no old copy of it.`);
      if (Date.now() - kept.at > WINDOW_MS) {
        throw new Error(`${service} moved more than ${MOVE_UNDO_WINDOW_HOURS} hours ago, so Undo is off. Its old copy stays on ${nameOf(store, kept.from)} until you delete it.`);
      }
      if (WRITES.has(sv.id)) throw new Error(`Writes happened on ${nameOf(store, kept.to)} since the move; undoing would lose them.`);
      const state: MoveState = {
        id: `un-${Date.now().toString(36)}`,
        step: 'stop',
        from: kept.to,
        to: kept.from,
        volumes: kept.volumes,
        replicas: sv.replicas.desired,
        startedAt: new Date().toISOString(),
        undo: true,
      };
      moves(store)[sv.id] = state;
      for (const [step, at] of STEPS) setTimeout(() => moves(store)[sv.id] && (moves(store)[sv.id] = { ...state, step }), at * 1000);
      setTimeout(() => {
        sv.nodeId = kept.from;
        sv.constraints = [`node.id == swarm-${kept.from}`];
        delete moves(store)[sv.id];
        // The copy on the server it left is the old copy now.
        oldCopies(store)[sv.id] = { from: kept.to, to: kept.from, at: Date.now(), volumes: kept.volumes };
      }, DONE_AT_S * 1000);
      return { started: true, service, from: kept.to, to: kept.from };
    },
    'decommission.oldCopies': (i, store) => {
      const { id } = i as { id: string };
      const now = Date.now();
      return store.services.flatMap((sv) => {
        const kept = oldCopies(store)[sv.id];
        if (!kept || kept.from !== id || sv.nodeId === id) return [];
        const undoUntil = now - kept.at <= WINDOW_MS && !moves(store)[sv.id] ? new Date(kept.at + WINDOW_MS).toISOString() : null;
        const promptAt = new Date(kept.at + OLD_COPY_KEEP_DAYS * 86_400_000).toISOString();
        return kept.volumes.map((volume) => ({ service: sv.name, volume, movedAt: new Date(kept.at).toISOString(), promptAt, due: false, undoUntil }));
      });
    },
  },
};
