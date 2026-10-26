/**
 * Undo a move (board 9) — the IO half of `@swarmy/core` `volume-move-undo.ts`.
 * Copies nothing: it points the service back at the old copy the move kept,
 * and only once the rule has seen both copies match the move's snapshot point.
 *
 *   check   (awaited by the router, so a refusal reaches the person) the
 *           read-only refusals, then a manifest of the old copy and of the
 *           moved copy while the app still runs.
 *   run     (background, progress on `swarmy.move.state` with `undo: true`)
 *           stop the app, read the moved copy again now nothing writes to it,
 *           re-pin to the old server, start it there. The moved copy is kept
 *           as the old copy now, with the same snapshot point.
 *
 * Any failure before the app starts on the old server puts it back where it
 * was. Audited like the move: `volume.move.undo` / `.rolledBack`.
 */
import {
  MOVE_OLD_COPIES_LABEL,
  MOVE_STATE_LABEL,
  PINNED_DATA_LABELS,
  copiesAfterUndo,
  decideUndo,
  lastMove,
  newMoveId,
  oldCopy,
  parseOldCopies,
  repinSpec,
  type LastMove,
  type MoveState,
  type MoveStep,
  type UndoInput,
  type VolumeManifest,
} from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { liveServiceSpec } from './service-patch';
import { manifestOn, nodesRunning, realDeps, waitFor, type MoverDeps } from './volumeMove.service';

const STOP_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 180_000;

type Ctx = OrgContext;
type Side = { nodeId: string; hostname: string };

export interface UndoPlan {
  svc: SwarmServiceInfo;
  move: LastMove & { dest: string };
  source: Side;
  dest: Side;
  replicas: number;
  input: UndoInput;
}

const side = (ctx: Ctx, nodeId: string): Side => ({ nodeId, hostname: ctx.hub.nodeInfoFor(nodeId)?.hostname ?? nodeId });

function ready(ctx: Ctx, nodeId: string): boolean {
  const n = ctx.hub.nodeInfoFor(nodeId);
  return ctx.hub.isOnline(nodeId) && (!n || (n.availability === 'active' && n.status === 'ready'));
}

/** Each volume's manifest on `nodeId` now (null when it can't be read). */
async function readSide(ctx: Ctx, nodeId: string, move: LastMove): Promise<Map<string, VolumeManifest | null>> {
  const out = new Map<string, VolumeManifest | null>();
  for (const c of move.copies) out.set(c.volume, await manifestOn(ctx, nodeId, c.volume, true).catch(() => null));
  return out;
}

/** Every refusal before anything stops, both copies read once. Throws in plain words. */
export async function checkUndoMove(ctx: Ctx, req: { service: string }, deps: MoverDeps = realDeps): Promise<UndoPlan> {
  const svc = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === req.service);
  if (!svc) throw notFound('service', req.service);
  const move = lastMove(parseOldCopies(svc.labels[MOVE_OLD_COPIES_LABEL]));
  const source = side(ctx, move?.source ?? '');
  const dest = side(ctx, move?.dest ?? '');
  let input: UndoInput = {
    move,
    now: deps.now(),
    runningOn: nodesRunning(ctx, svc.name),
    moving: Boolean(svc.labels[MOVE_STATE_LABEL]),
    sourceReady: move ? ready(ctx, move.source) : false,
    names: { service: svc.name, source: source.hostname, dest: dest.hostname },
  };
  let d = decideUndo(input);
  if (d.ok && d.next === 'read-source') d = decideUndo((input = { ...input, sourceNow: await readSide(ctx, source.nodeId, move!) }));
  if (d.ok && d.next === 'read-dest') d = decideUndo((input = { ...input, destNow: await readSide(ctx, dest.nodeId, move!) }));
  if (!d.ok) throw commandRejected(d.reason);
  return { svc, move: move as UndoPlan['move'], source, dest, replicas: svc.desiredReplicas ?? 1, input };
}

/** Stop, check the moved copy again, re-pin to the old copy, start. Resolves once it runs there. */
export async function runUndoMove(ctx: Ctx, plan: UndoPlan, deps: MoverDeps = realDeps): Promise<void> {
  const { svc, move, source, dest, replicas } = plan;
  const manager = await resolveManagerNode(ctx);
  const sourceSwarm = ctx.hub.swarmNodeIdFor(source.nodeId);
  if (!sourceSwarm) throw commandRejected(`${source.hostname} has not reported its swarm membership yet.`);
  const volumes = move.copies.map((c) => c.volume);
  const state: MoveState = { id: newMoveId(deps.now()), step: 'stop', from: dest.nodeId, to: source.nodeId, volumes, replicas, startedAt: new Date(deps.now()).toISOString(), undo: true };
  const labels = (add: Record<string, string>, removeKeys: string[] = []) =>
    ctx.hub.dispatch(manager.id, 'service.updateLabels', { service: svc.name, add, removeKeys });
  const setState = async (step: MoveStep) => {
    state.step = step;
    await labels({ [MOVE_STATE_LABEL]: JSON.stringify(state) });
  };
  const original = await liveServiceSpec(ctx, manager.id, svc);
  let started = false;
  try {
    await setState('stop');
    await ctx.hub.dispatch(manager.id, 'service.scale', { service: svc.name, replicas: 0 });
    await waitFor(deps, STOP_TIMEOUT_MS, () => nodesRunning(ctx, svc.name).length === 0, `${svc.name} to stop`);

    // Nothing writes to the moved copy now: read it again, so a write since the check still refuses.
    await setState('verify');
    const d = decideUndo({ ...plan.input, now: deps.now(), destNow: await readSide(ctx, dest.nodeId, move) });
    if (!d.ok) throw commandRejected(d.reason);

    await setState('repin');
    const back = repinSpec(original, sourceSwarm, PINNED_DATA_LABELS);
    const now = deps.now();
    const left = move.copies.map((c) => oldCopy(dest.nodeId, c.volume, now, { moveId: state.id, to: source.nodeId, manifest: c.manifest }));
    back.labels = {
      ...(back.labels ?? {}),
      [MOVE_STATE_LABEL]: JSON.stringify({ ...state, step: 'start' }),
      [MOVE_OLD_COPIES_LABEL]: JSON.stringify(copiesAfterUndo(parseOldCopies(original.labels?.[MOVE_OLD_COPIES_LABEL]), move, left)),
    };
    back.mode = { replicated: { replicas } };
    await ctx.hub.dispatch(manager.id, 'service.deploy', { spec: back, pullPolicy: 'missing' });
    await waitFor(deps, START_TIMEOUT_MS, () => nodesRunning(ctx, svc.name).includes(source.nodeId), `${svc.name} to start on ${source.hostname}`);
    started = true;
    await labels({}, [MOVE_STATE_LABEL]);
    await writeAudit(ctx, {
      action: 'volume.move.undo',
      targetType: 'service',
      targetId: svc.name,
      metadata: { moveId: move.moveId, undoId: state.id, from: dest.hostname, to: source.hostname, volumes },
    });
  } catch (err) {
    if (!started) {
      if (state.step === 'repin' || state.step === 'start') {
        const spec = { ...original, mode: { replicated: { replicas } } } as ServiceSpec;
        await ctx.hub.dispatch(manager.id, 'service.deploy', { spec, pullPolicy: 'missing' }).catch(() => undefined);
      } else {
        await ctx.hub.dispatch(manager.id, 'service.scale', { service: svc.name, replicas }).catch(() => undefined);
      }
      await labels({}, [MOVE_STATE_LABEL]).catch(() => undefined);
      await writeAudit(ctx, {
        action: 'volume.move.undo.rolledBack',
        targetType: 'service',
        targetId: svc.name,
        metadata: { moveId: move.moveId, step: state.step, from: dest.hostname, to: source.hostname, error: (err as Error).message },
      });
    }
    throw err;
  }
}
