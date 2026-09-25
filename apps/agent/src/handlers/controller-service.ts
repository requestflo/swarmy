/**
 * `controllerService` — the controller's lease and placement, applied on a
 * manager's local Docker socket (resilience P3).
 *
 * Every write is `service update ?version=<index>` against the index this
 * handler just inspected, so two writers can't both win: the loser gets
 * "update out of sequence" and reports `conflict`. Lease writes only touch
 * `Spec.Labels` (outside the TaskTemplate), so they never restart the task.
 * The handler refuses any service that is not labelled `swarmy.system=true`.
 */
import type { DockerClient } from '@swarmy/core/docker';
import {
  CONTROLLER_AVOID_CONSTRAINT,
  CONTROLLER_AVOID_LABEL,
  CONTROLLER_FLOATING_CONSTRAINT,
  CONTROLLER_LEASE_LABEL,
  CONTROLLER_STORE_SECRET_TARGET,
  casLossReason,
  decideLeaseWrite,
  isControllerPlacementConstraint,
  parseLeaseLabel,
  pinnedConstraint,
  type ControllerServicePayload,
  type ControllerServiceResult,
} from '@swarmy/core/protocol';

interface SecretRef {
  File?: { Name?: string; UID?: string; GID?: string; Mode?: number };
  SecretID?: string;
  SecretName?: string;
}

interface ServiceSpecLike {
  Labels?: Record<string, string>;
  TaskTemplate?: {
    ForceUpdate?: number;
    ContainerSpec?: { Secrets?: SecretRef[]; Env?: string[] };
    Placement?: { Constraints?: string[] };
  };
  [k: string]: unknown;
}

/** Docker's stale-index rejection, i.e. somebody else wrote first. */
export function isOutOfSequence(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /out of sequence|update out of sequence|version.*(mismatch|out of date)/i.test(msg);
}

/** Placement constraints for the op (pure). Keeps every unrelated constraint. */
export function nextConstraints(
  current: string[] | undefined,
  placement: 'floating' | 'pinned',
  pinnedHostname?: string,
): string[] {
  const kept = (current ?? []).filter(
    (c) => !isControllerPlacementConstraint(c) && c.replace(/\s+/g, '') !== CONTROLLER_AVOID_CONSTRAINT.replace(/\s+/g, ''),
  );
  const own =
    placement === 'floating'
      ? CONTROLLER_FLOATING_CONSTRAINT
      : pinnedConstraint(pinnedHostname ?? (() => {
          throw new Error('pinned placement needs a hostname');
        })());
  return [own, CONTROLLER_AVOID_CONSTRAINT, ...kept];
}

/** Replace (or add) the secret mounted at /run/secrets/control_store (pure). */
export function nextSecrets(current: SecretRef[] | undefined, secretId: string, secretName: string): SecretRef[] {
  const others = (current ?? []).filter((s) => s.File?.Name !== CONTROLLER_STORE_SECRET_TARGET);
  return [
    ...others,
    {
      SecretID: secretId,
      SecretName: secretName,
      File: { Name: CONTROLLER_STORE_SECRET_TARGET, UID: '0', GID: '0', Mode: 0o400 },
    },
  ];
}

export async function applyControllerService(
  docker: DockerClient,
  p: ControllerServicePayload,
  now: () => number = Date.now,
): Promise<ControllerServiceResult> {
  const svc = await docker.getServiceByName(p.service);
  if (!svc) return { ok: false, lease: null, reason: 'not-found' };
  const inspect = (await svc.inspect()) as { Version: { Index: number }; Spec: ServiceSpecLike };
  const spec = inspect.Spec;
  if (spec.Labels?.['swarmy.system'] !== 'true') return { ok: false, lease: null, reason: 'not-system' };
  const live = parseLeaseLabel(spec.Labels?.[CONTROLLER_LEASE_LABEL]);

  const write = async (next: ServiceSpecLike): Promise<boolean> => {
    try {
      await svc.update({ version: inspect.Version.Index, ...next });
      return true;
    } catch (e) {
      if (isOutOfSequence(e)) return false;
      throw e;
    }
  };

  const op = p.op;
  switch (op.kind) {
    case 'lease.acquire':
    case 'lease.renew':
    case 'lease.release': {
      const { next, result } = decideLeaseWrite(live, op, now());
      if (!next) return result;
      const ok = await write({ ...spec, Labels: { ...(spec.Labels ?? {}), [CONTROLLER_LEASE_LABEL]: JSON.stringify(next) } });
      if (ok) return result;
      // Lost the CAS race: report the label as it is now.
      const again = (await svc.inspect()) as { Spec: ServiceSpecLike };
      const current = parseLeaseLabel(again.Spec.Labels?.[CONTROLLER_LEASE_LABEL]);
      return { ok: false, lease: current, reason: casLossReason(op, current) };
    }
    case 'configure': {
      const tt = { ...(spec.TaskTemplate ?? {}) };
      const cs = { ...(tt.ContainerSpec ?? {}) };
      if (op.storeSecret) {
        const secret = (await docker.docker.listSecrets({ filters: { name: [op.storeSecret] } })).find(
          (s) => s.Spec?.Name === op.storeSecret,
        );
        if (!secret?.ID) throw new Error(`secret not found: ${op.storeSecret}`);
        cs.Secrets = nextSecrets(cs.Secrets, secret.ID, op.storeSecret);
      }
      tt.ContainerSpec = cs;
      tt.Placement = { ...(tt.Placement ?? {}), Constraints: nextConstraints(tt.Placement?.Constraints, op.placement, op.pinnedHostname) };
      const ok = await write({ ...spec, TaskTemplate: tt });
      return ok ? { ok: true, lease: live, restarting: true } : { ok: false, lease: live, reason: 'conflict' };
    }
    case 'move': {
      const nodes = await docker.docker.listNodes();
      const target = nodes.find((n) => n.ID === op.targetNodeId);
      const targetSpec = (target?.Spec ?? {}) as { Role?: string; Availability?: string };
      if (!target || targetSpec.Role !== 'manager' || (targetSpec.Availability ?? 'active') !== 'active') {
        throw new Error('the target must be an active manager node');
      }
      const labelled: string[] = [];
      // The controller's own node goes last: labelling it evicts the task.
      const ordered = [...nodes].sort((a, b) => Number(a.ID === op.fromNodeId) - Number(b.ID === op.fromNodeId));
      for (const n of ordered) {
        const nspec = (n.Spec ?? {}) as { Role?: string; Labels?: Record<string, string> };
        if (nspec.Role !== 'manager') continue;
        const avoid = n.ID !== op.targetNodeId;
        const has = nspec.Labels?.[CONTROLLER_AVOID_LABEL] === 'true';
        if (avoid === has) continue;
        await setNodeAvoid(docker, n.ID as string, avoid);
        labelled.push(n.ID as string);
      }
      // Swarm's constraint enforcer stops a running task whose node stops
      // matching its constraints, so labelling the current node "avoid" IS the
      // move: the task gets SIGTERM (clean shutdown, final sync, lease release)
      // and the scheduler places the new one on the only eligible manager.
      // Only a spec that predates the avoid constraint needs an update to pick it up.
      const constraints = nextConstraints(spec.TaskTemplate?.Placement?.Constraints, 'floating');
      const current = spec.TaskTemplate?.Placement?.Constraints ?? [];
      if (constraints.join('\n') !== current.join('\n')) {
        const tt = { ...(spec.TaskTemplate ?? {}) };
        tt.Placement = { ...(tt.Placement ?? {}), Constraints: constraints };
        const ok = await write({ ...spec, TaskTemplate: tt });
        if (!ok) return { ok: false, lease: live, reason: 'conflict', labelled };
      }
      return { ok: true, lease: live, restarting: true, labelled };
    }
    case 'move.clear': {
      const labelled: string[] = [];
      for (const n of await docker.docker.listNodes()) {
        const nspec = (n.Spec ?? {}) as { Labels?: Record<string, string> };
        if (!(CONTROLLER_AVOID_LABEL in (nspec.Labels ?? {}))) continue;
        await setNodeAvoid(docker, n.ID as string, false);
        labelled.push(n.ID as string);
      }
      return { ok: true, lease: live, labelled };
    }
  }
}

/** Add or remove `swarmy.controller.avoid` on one node (version-checked). */
async function setNodeAvoid(docker: DockerClient, nodeId: string, avoid: boolean): Promise<void> {
  const node = docker.docker.getNode(nodeId);
  const inspect = (await node.inspect()) as { Version: { Index: number }; Spec: { Labels?: Record<string, string> } };
  const labels = { ...(inspect.Spec.Labels ?? {}) };
  if (avoid) labels[CONTROLLER_AVOID_LABEL] = 'true';
  else delete labels[CONTROLLER_AVOID_LABEL];
  await node.update({ version: inspect.Version.Index, ...inspect.Spec, Labels: labels });
}
