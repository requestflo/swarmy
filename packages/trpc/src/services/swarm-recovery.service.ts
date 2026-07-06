/**
 * Swarm quorum monitoring + recovery tooling (roadmap WS2).
 *
 * Everything here works on Docker truth: the manager census comes from the
 * hub's live node inventory, autolock/rotation run as agent commands on a
 * manager, and the ONLY thing persisted is swarmy's own secret material —
 * encrypted join tokens and (opt-in) the encrypted autolock unlock key on the
 * org's SwarmConfig row, next to the tokens the swarm service already stores.
 *
 * Secrets discipline: the unlock key is returned to a client exactly once —
 * either from `setAutolock(..., { storeKey: false })` (stored nowhere) or from
 * `revealUnlockKey` (admin-only, audited). Audit rows never carry key material.
 */
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type {
  SwarmNodeInfo,
  SwarmRotateTokensResult,
  SwarmSetAutolockResult,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';

const RECOVERY_DISPATCH_TIMEOUT_MS = 30_000;

// ── Pure: manager census + quorum math ────────────────────────────────────────

export interface ManagerCensus {
  total: number;
  /** Managers the cluster currently reports `ready`. */
  reachable: number;
}

export function managerCensus(nodes: SwarmNodeInfo[]): ManagerCensus {
  const managers = nodes.filter((n) => n.role === 'manager');
  return {
    total: managers.length,
    reachable: managers.filter((n) => n.status === 'ready').length,
  };
}

/** Raft majority for a manager set of `total`. */
export function majorityOf(total: number): number {
  return Math.floor(total / 2) + 1;
}

export type QuorumVerdict = 'no-swarm' | 'single-manager' | 'healthy' | 'at-risk' | 'lost';

/** Plain-words quorum verdict for the health card (mirrors the resilience checks). */
export function quorumVerdict(census: ManagerCensus): { verdict: QuorumVerdict; message: string } {
  const { total, reachable } = census;
  if (total === 0) return { verdict: 'no-swarm', message: 'No swarm managers yet.' };
  if (total === 1) {
    return {
      verdict: 'single-manager',
      message:
        reachable === 1
          ? 'One manager — losing it freezes the control plane. Promote two more nodes.'
          : 'The only manager is unreachable — the control plane is down.',
    };
  }
  const majority = majorityOf(total);
  const down = total - reachable;
  if (reachable < majority) {
    return {
      verdict: 'lost',
      message: `Quorum lost: only ${reachable} of ${total} managers reachable (majority is ${majority}).`,
    };
  }
  if (reachable === majority) {
    return {
      verdict: 'at-risk',
      message:
        down > 0
          ? `You have ${total} managers but ${down} ${down === 1 ? 'is' : 'are'} offline — one more failure loses quorum.`
          : `All ${total} managers are up, but a single loss drops below the majority of ${majority}.`,
    };
  }
  return {
    verdict: 'healthy',
    message: `${reachable} of ${total} managers reachable — the swarm survives ${reachable - majority} more manager ${reachable - majority === 1 ? 'failure' : 'failures'}.`,
  };
}

/**
 * QUORUM GUARD — the plain-words reason a demote must be refused, or null when
 * it is safe. Refuses demoting the last manager outright, and any demote that
 * would drop reachable managers below the majority of the REMAINING set.
 */
export function demoteRefusalReason(census: ManagerCensus, targetReachable: boolean): string | null {
  if (census.total <= 1) {
    return 'This is the only manager — demoting it would leave the swarm with no control plane at all. Promote another node first.';
  }
  const remaining = census.total - 1;
  const remainingReachable = census.reachable - (targetReachable ? 1 : 0);
  const majority = majorityOf(remaining);
  if (remainingReachable < majority) {
    return `Demoting this node would leave ${remainingReachable} reachable manager${remainingReachable === 1 ? '' : 's'} of ${remaining} — below the majority of ${majority} the swarm needs. Bring offline managers back (or promote a healthy node) first.`;
  }
  return null;
}

// ── Health (derived, never stored) ────────────────────────────────────────────

export interface SwarmHealthView {
  managers: {
    total: number;
    reachable: number;
    majority: number;
    verdict: QuorumVerdict;
    message: string;
  };
  workers: { total: number };
  autolock: {
    /** True when an encrypted unlock key is stored on the org's SwarmConfig. */
    keyStored: boolean;
    /** Enrolled nodes currently reporting a `locked` local swarm state. */
    lockedNodes: number;
  };
  managerNodes: Array<{ hostname: string; reachable: boolean; leader: boolean }>;
}

export async function swarmHealth(ctx: OrgContext): Promise<SwarmHealthView> {
  const nodes = ctx.hub.nodeInventory(ctx.activeOrgId, true);
  const census = managerCensus(nodes);
  const { verdict, message } = quorumVerdict(census);

  const [cfg, enrolled] = await Promise.all([
    ctx.db.swarmConfig.findUnique({
      where: { orgId: ctx.activeOrgId },
      select: { unlockKeyEnc: true },
    }),
    ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true } }),
  ]);
  const lockedNodes = enrolled.filter((n) => ctx.hub.swarmStateFor(n.id) === 'locked').length;

  return {
    managers: {
      total: census.total,
      reachable: census.reachable,
      majority: census.total > 0 ? majorityOf(census.total) : 0,
      verdict,
      message,
    },
    workers: { total: nodes.filter((n) => n.role === 'worker').length },
    autolock: { keyStored: Boolean(cfg?.unlockKeyEnc), lockedNodes },
    managerNodes: nodes
      .filter((n) => n.role === 'manager')
      .map((n) => ({ hostname: n.hostname, reachable: n.status === 'ready', leader: n.leader })),
  };
}

// ── Autolock ──────────────────────────────────────────────────────────────────

export interface SetAutolockResult {
  enabled: boolean;
  /** True when the (encrypted) unlock key is now stored on the SwarmConfig row. */
  keyStored: boolean;
  /** Present exactly once: enabling with `storeKey: false` — store it yourself. */
  unlockKey?: string;
}

export async function setAutolock(
  ctx: OrgContext,
  enabled: boolean,
  opts: { storeKey?: boolean } = {},
): Promise<SetAutolockResult> {
  const storeKey = opts.storeKey !== false;
  const manager = await resolveManagerNode(ctx);

  let res: SwarmSetAutolockResult;
  try {
    res = await ctx.hub.dispatch<SwarmSetAutolockResult>(
      manager.id,
      'swarm.autolock',
      { enabled },
      { timeoutMs: RECOVERY_DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  if (enabled && !res.unlockKey) {
    throw commandRejected('autolock was enabled but Docker returned no unlock key');
  }

  const unlockKeyEnc = enabled && storeKey && res.unlockKey ? encryptSecret(res.unlockKey) : null;
  await ctx.db.swarmConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, unlockKeyEnc },
    update: { unlockKeyEnc },
  });

  await writeAudit(ctx, {
    action: 'swarm.autolock',
    targetType: 'swarm',
    targetId: ctx.activeOrgId,
    // Never the key itself — only what happened to it.
    metadata: { enabled, keyStored: unlockKeyEnc != null },
  });

  return {
    enabled,
    keyStored: unlockKeyEnc != null,
    ...(enabled && !storeKey ? { unlockKey: res.unlockKey } : {}),
  };
}

/** Decrypt the stored unlock key (admin only — enforced by the router; audited). */
export async function revealUnlockKey(ctx: OrgContext): Promise<{ unlockKey: string }> {
  const cfg = await ctx.db.swarmConfig.findUnique({
    where: { orgId: ctx.activeOrgId },
    select: { unlockKeyEnc: true },
  });
  if (!cfg?.unlockKeyEnc) throw notFound('stored unlock key');
  await writeAudit(ctx, {
    action: 'swarm.unlockKey.reveal',
    targetType: 'swarm',
    targetId: ctx.activeOrgId,
  });
  return { unlockKey: decryptSecret(cfg.unlockKeyEnc) };
}

// ── Join-token rotation ───────────────────────────────────────────────────────

export async function rotateJoinTokens(
  ctx: OrgContext,
  roles: Array<'manager' | 'worker'> = ['manager', 'worker'],
): Promise<{ rotated: Array<'manager' | 'worker'> }> {
  const manager = await resolveManagerNode(ctx);
  let res: SwarmRotateTokensResult;
  try {
    res = await ctx.hub.dispatch<SwarmRotateTokensResult>(
      manager.id,
      'swarm.rotateTokens',
      { roles },
      { timeoutMs: RECOVERY_DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }

  // Re-encrypt + store the post-rotation tokens where the old ones live. The
  // agent returns BOTH current tokens, so storing both self-heals any drift.
  const data = {
    workerJoinTokenEnc: res.joinTokens.worker ? encryptSecret(res.joinTokens.worker) : null,
    managerJoinTokenEnc: res.joinTokens.manager ? encryptSecret(res.joinTokens.manager) : null,
  };
  await ctx.db.swarmConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, ...data },
    update: data,
  });

  await writeAudit(ctx, {
    action: 'swarm.tokens.rotate',
    targetType: 'swarm',
    targetId: ctx.activeOrgId,
    metadata: { roles },
  });
  return { rotated: roles };
}

// ── Promote / demote (via the extended updateSwarmNode role field) ────────────

async function requireOrgNode(ctx: OrgContext, id: string): Promise<{ id: string; name: string }> {
  const node = await ctx.db.node.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  if (!node) throw notFound('node', id);
  return node;
}

async function setNodeRole(
  ctx: OrgContext,
  id: string,
  role: 'manager' | 'worker',
): Promise<{ id: string; role: 'manager' | 'worker' }> {
  const node = await requireOrgNode(ctx, id);
  const swarmNodeId = ctx.hub.swarmNodeIdFor(id);
  if (!swarmNodeId) {
    throw commandRejected(`${node.name} has no live swarm identity — is it in the swarm?`);
  }
  // `docker node promote/demote` is manager-only; prefer a manager OTHER than
  // the target so demoting a manager never races its own control-plane exit.
  const via =
    ctx.hub.managerNodes(ctx.activeOrgId).find((m) => m !== id) ??
    (await resolveManagerNode(ctx)).id;
  try {
    await ctx.hub.dispatch(
      via,
      'node.update',
      { swarmNodeId, role },
      { timeoutMs: RECOVERY_DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: role === 'manager' ? 'swarm.node.promote' : 'swarm.node.demote',
    targetType: 'node',
    targetId: id,
    metadata: { swarmNodeId, role },
  });
  return { id, role };
}

export async function promoteNode(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; role: 'manager' | 'worker' }> {
  const info = ctx.hub.nodeInfoFor(id);
  if (info?.role === 'manager') return { id, role: 'manager' };
  return setNodeRole(ctx, id, 'manager');
}

export async function demoteNode(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; role: 'manager' | 'worker' }> {
  const info = ctx.hub.nodeInfoFor(id);
  if (info?.role !== 'manager') return { id, role: 'worker' };
  const census = managerCensus(ctx.hub.nodeInventory(ctx.activeOrgId, true));
  const reason = demoteRefusalReason(census, info.status === 'ready');
  if (reason) throw commandRejected(reason);
  return setNodeRole(ctx, id, 'worker');
}
