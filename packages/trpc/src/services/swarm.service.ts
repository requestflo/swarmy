/**
 * Swarm orchestration (node-onboarding epic, PHASE-2+).
 *
 * Decides, when a node comes online, whether the org's Docker Swarm needs to be
 * initialised (this is the FIRST node) or whether the node should join an
 * existing swarm — then dispatches the single `swarmJoin` command to the agent,
 * which runs `docker swarm init` / `docker swarm join` locally.
 *
 * Secrets discipline: Docker's own join tokens (`SWMTKN-…`) returned by `init`
 * are stored ENCRYPTED on a per-org `SwarmConfig` row (see the Prisma INTEGRATION
 * snippet) and decrypted just-in-time to hand to a joining node. They are never
 * returned to clients and never written in plaintext.
 *
 * Called from the gateway register path (see the INTEGRATION snippet wiring this
 * into `handleRegister`). Kept dependency-light (db + hub) so it works outside an
 * OrgContext and is unit-testable with stubs.
 */
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type { CommandName } from '../hub/types';

/** Hub surface this service needs (subset of AgentHub). */
export interface SwarmHub {
  isOnline(nodeId: string): boolean;
  dispatch<R = unknown>(
    nodeId: string,
    cmd: CommandName,
    payload: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<R>;
}

/** Persisted, encrypted swarm config for an org (the `SwarmConfig` model). */
export interface SwarmConfigRow {
  orgId: string;
  swarmId: string | null;
  managerNodeId: string | null;
  managerAddr: string | null;
  /** Encrypted Docker worker join token (`SWMTKN-…`). */
  workerJoinTokenEnc: string | null;
  /** Encrypted Docker manager join token (`SWMTKN-…`). */
  managerJoinTokenEnc: string | null;
  /** Encrypted swarm autolock unlock key (`SWMKEY-…`), when the operator stores it here (WS2). */
  unlockKeyEnc: string | null;
}

/** The minimal Prisma surface this service uses (keeps it model-agnostic + testable). */
export interface SwarmDb {
  swarmConfig: {
    findUnique(args: { where: { orgId: string } }): Promise<SwarmConfigRow | null>;
    upsert(args: {
      where: { orgId: string };
      create: SwarmConfigRow;
      update: Partial<SwarmConfigRow>;
    }): Promise<SwarmConfigRow>;
  };
}

/** Result of `swarmJoin` as it arrives in `commandResult.result`. */
interface SwarmJoinResultLike {
  mode: 'init' | 'join';
  swarmNodeId: string;
  managerAddr?: string;
  joinTokens?: { worker: string; manager: string };
}

export interface OrchestrateArgs {
  db: SwarmDb;
  hub: SwarmHub;
  orgId: string;
  nodeId: string;
  /** The node's preferred role from its join token (worker by default). */
  roleHint?: 'manager' | 'worker' | null;
  /** True when the node already reported an active swarm membership (no-op). */
  alreadyInSwarm?: boolean;
}

export type OrchestrateOutcome =
  | { action: 'noop'; reason: string }
  | { action: 'init'; swarmNodeId: string }
  | { action: 'join'; role: 'manager' | 'worker'; swarmNodeId: string };

/**
 * Command name used to reach the agent (mapped to wire `swarmJoin` in the hub).
 * `'swarm.join'` is added to `CommandName` + `COMMAND_PROTOCOL_TYPE` via the hub
 * INTEGRATION snippet; cast keeps this file standalone-compilable pre-integration.
 */
export const SWARM_COMMAND = 'swarm.join' as CommandName;
const SWARM_DISPATCH_TIMEOUT_MS = 60_000;

/**
 * Orchestrate swarm membership for a node that has just registered.
 *
 *  - already in a swarm        → no-op (idempotent)
 *  - org has no swarm yet       → `init` this node (becomes manager), store tokens
 *  - org has a swarm + manager  → `join` this node (worker, or manager if hinted)
 */
export async function orchestrateSwarmMembership(args: OrchestrateArgs): Promise<OrchestrateOutcome> {
  const { db, hub, orgId, nodeId } = args;

  if (args.alreadyInSwarm) {
    return { action: 'noop', reason: 'node already in a swarm' };
  }
  if (!hub.isOnline(nodeId)) {
    return { action: 'noop', reason: 'node offline' };
  }

  const cfg = await db.swarmConfig.findUnique({ where: { orgId } });

  // ── First node in the org: initialise the swarm here. ──────────────────
  if (!cfg || !cfg.swarmId) {
    const res = await hub.dispatch<SwarmJoinResultLike>(
      nodeId,
      SWARM_COMMAND,
      { mode: 'init', advertiseAddr: undefined },
      { timeoutMs: SWARM_DISPATCH_TIMEOUT_MS },
    );
    const tokens = res.joinTokens ?? { worker: '', manager: '' };
    const row: SwarmConfigRow = {
      orgId,
      swarmId: res.swarmNodeId,
      managerNodeId: nodeId,
      managerAddr: res.managerAddr ?? null,
      workerJoinTokenEnc: tokens.worker ? encryptSecret(tokens.worker) : null,
      managerJoinTokenEnc: tokens.manager ? encryptSecret(tokens.manager) : null,
      unlockKeyEnc: null,
    };
    await db.swarmConfig.upsert({ where: { orgId }, create: row, update: row });
    // The node's swarm id + role are Docker truth (read via `hub.swarmNodeIdFor`/
    // `nodeInfoFor`) — never written back to the Node row.
    return { action: 'init', swarmNodeId: res.swarmNodeId };
  }

  // ── Joining an existing swarm. ─────────────────────────────────────────
  const role: 'manager' | 'worker' = args.roleHint === 'manager' ? 'manager' : 'worker';
  const tokenEnc = role === 'manager' ? cfg.managerJoinTokenEnc : cfg.workerJoinTokenEnc;
  if (!tokenEnc || !cfg.managerAddr) {
    return { action: 'noop', reason: 'no stored join token / manager address — node runs standalone' };
  }

  const res = await hub.dispatch<SwarmJoinResultLike>(
    nodeId,
    SWARM_COMMAND,
    {
      mode: 'join',
      role,
      joinToken: decryptSecret(tokenEnc),
      managerAddr: cfg.managerAddr,
    },
    { timeoutMs: SWARM_DISPATCH_TIMEOUT_MS },
  );
  // The node's swarm id + role are Docker truth (read via `hub.swarmNodeIdFor`/
  // `nodeInfoFor`) — never written back to the Node row.
  return { action: 'join', role, swarmNodeId: res.swarmNodeId };
}
