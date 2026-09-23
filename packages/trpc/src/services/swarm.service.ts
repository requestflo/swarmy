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
import type { SwarmState } from '@swarmy/core/protocol';
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
  mode: 'init' | 'join' | 'refresh';
  swarmNodeId: string;
  managerAddr?: string;
  joinTokens?: { worker: string; manager: string };
}

/**
 * A CONNECTED org peer of the registering node, as the gateway sees it. The
 * orchestrator never trusts the `swarm_config` row alone: whether a manager is
 * actually alive is Docker/hub truth, read from here.
 */
export interface SwarmPeer {
  nodeId: string;
  /** From the peer's serviceState (`ControlAvailable`). `undefined` = not reported yet. */
  isManager?: boolean;
  /** Local swarm membership (`undefined` = legacy agent / not reported yet). */
  swarmState?: SwarmState;
}

/** A non-secret orchestration event, for audit + the node's dashboard status. */
export interface SwarmOrchestrationEvent {
  orgId: string;
  nodeId: string;
  state: SwarmOrchestrationState;
  detail: string;
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
  /**
   * The node's confirmed mesh IP (epic: zero-trust-networking, mesh-first
   * join), when mesh is enabled for the org and the agent joined + confirmed
   * connectivity before registering. Used as `advertiseAddr` so swarm control
   * + data-plane traffic rides the mesh instead of the LAN. `null`/absent ⇒
   * falls back to the agent's own LAN-address self-derivation, unchanged from
   * before this feature.
   */
  meshIp?: string | null;
  /**
   * The org's OTHER connected nodes (live hub truth). Drives manager-liveness:
   * a live manager always wins over the stored row (never `init` a second
   * swarm next to it), and a stale row with no live manager is re-elected.
   * Absent ⇒ treated as "no peers" (legacy callers / tests).
   */
  peers?: () => SwarmPeer[];
  /** Observer for state transitions (audit/log). Must not throw. */
  onEvent?: (e: SwarmOrchestrationEvent) => void;
  /** Test seam: delay between deferred re-plans (default 5s). */
  deferDelayMs?: number;
}

export type OrchestrateOutcome =
  | { action: 'noop'; reason: string }
  | { action: 'init'; swarmNodeId: string; reelected?: boolean }
  | { action: 'join'; role: 'manager' | 'worker'; swarmNodeId: string };

/**
 * Command name used to reach the agent (mapped to wire `swarmJoin` in the hub).
 * `'swarm.join'` is added to `CommandName` + `COMMAND_PROTOCOL_TYPE` via the hub
 * INTEGRATION snippet; cast keeps this file standalone-compilable pre-integration.
 */
export const SWARM_COMMAND = 'swarm.join' as CommandName;
const SWARM_DISPATCH_TIMEOUT_MS = 60_000;
/** A token refresh on a healthy manager is a local read — fail fast. */
const SWARM_REFRESH_TIMEOUT_MS = 20_000;
/** Max times we wait for connected-but-unreported peers before deciding. */
export const MAX_DEFERS = 3;

// ── Pure decision logic (unit-tested) ────────────────────────────────────────

export interface SwarmPlanInput {
  alreadyInSwarm: boolean;
  online: boolean;
  role: 'manager' | 'worker';
  cfg: SwarmConfigRow | null;
  peers: SwarmPeer[];
  /** How many times this registration has already deferred. */
  defers: number;
}

export type SwarmPlan =
  | { kind: 'noop'; reason: string }
  /** Connected peers haven't reported their swarm role yet (e.g. right after a
   *  controller restart) — wait, don't guess: a guess here can split the swarm. */
  | { kind: 'defer'; reason: string }
  /** A live manager exists: pull FRESH join tokens + addr from it, then join. */
  | { kind: 'join-live'; role: 'manager' | 'worker'; managerNodeId: string }
  /** No live manager visible, but the row has join material: try it; if the
   *  join fails the stored manager is dead → re-elect (init here). */
  | { kind: 'join-stored'; role: 'manager' | 'worker'; managerAddr: string; tokenEnc: string }
  /** No usable swarm: init here. `reelect` = replacing a stale/dead row. */
  | { kind: 'init'; reelect: boolean; reason: string };

/** Connected peers that are working swarm managers right now. */
export function liveManagers(peers: SwarmPeer[]): string[] {
  return peers
    .filter((p) => p.isManager === true && (p.swarmState === undefined || p.swarmState === 'active'))
    .map((p) => p.nodeId);
}

/**
 * Decide what to do with a freshly-registered node.
 *
 * Invariant: we NEVER `init` while any connected org node is a live manager —
 * that is exactly how a rejoining worker formed a standalone swarm. And we
 * never follow a `swarm_config` row blindly: a live manager's fresh tokens
 * beat the stored ones, and a row whose manager is gone is re-elected.
 */
export function planSwarmMembership(input: SwarmPlanInput): SwarmPlan {
  const { cfg, peers, role } = input;
  if (input.alreadyInSwarm) return { kind: 'noop', reason: 'node already in a swarm' };
  if (!input.online) return { kind: 'noop', reason: 'node offline' };

  const live = liveManagers(peers);
  if (live.length > 0) {
    // Prefer the recorded manager when it's among the live ones.
    const managerNodeId = cfg?.managerNodeId && live.includes(cfg.managerNodeId) ? cfg.managerNodeId : live[0]!;
    return { kind: 'join-live', role, managerNodeId };
  }

  const unsettled = peers.filter((p) => p.isManager === undefined);
  if (unsettled.length > 0 && input.defers < MAX_DEFERS) {
    return { kind: 'defer', reason: `${unsettled.length} connected node(s) have not reported swarm role yet` };
  }

  if (cfg?.swarmId) {
    const tokenEnc = role === 'manager' ? cfg.managerJoinTokenEnc : cfg.workerJoinTokenEnc;
    if (tokenEnc && cfg.managerAddr) {
      return { kind: 'join-stored', role, managerAddr: cfg.managerAddr, tokenEnc };
    }
    return {
      kind: 'init',
      reelect: true,
      reason: 'recorded swarm has no join material and no manager is online — starting a new swarm here',
    };
  }
  return { kind: 'init', reelect: false, reason: 'first node in the org' };
}

/**
 * After a `join-stored` attempt failed: if a live manager has since appeared,
 * join it with fresh tokens; otherwise the recorded manager is dead → re-elect.
 */
export function planAfterStoredJoinFailure(
  role: 'manager' | 'worker',
  peers: SwarmPeer[],
): Extract<SwarmPlan, { kind: 'join-live' } | { kind: 'init' }> {
  const live = liveManagers(peers);
  if (live.length > 0) return { kind: 'join-live', role, managerNodeId: live[0]! };
  return {
    kind: 'init',
    reelect: true,
    reason: 'the recorded swarm manager is unreachable and no manager is online — this node started a new swarm',
  };
}

// ── Orchestration status (surfaced on the node detail) ───────────────────────

export type SwarmOrchestrationState =
  | 'waiting'
  | 'joining'
  | 'joined'
  | 'initialised'
  | 'reelected'
  | 'failed';

export interface SwarmOrchestrationStatus {
  state: SwarmOrchestrationState;
  detail: string;
  at: string;
}

const statusByNode = new Map<string, SwarmOrchestrationStatus>();

/** Last orchestration outcome for a node (process-local, like the hub). */
export function swarmOrchestrationStatus(nodeId: string): SwarmOrchestrationStatus | null {
  return statusByNode.get(nodeId) ?? null;
}

function setStatus(args: OrchestrateArgs, state: SwarmOrchestrationState, detail: string): void {
  statusByNode.set(args.nodeId, { state, detail, at: new Date().toISOString() });
  try {
    args.onEvent?.({ orgId: args.orgId, nodeId: args.nodeId, state, detail });
  } catch {
    /* observers never break orchestration */
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Orchestration (IO) ───────────────────────────────────────────────────────

/**
 * Orchestrate swarm membership for a node that has just registered.
 *
 *  - already in a swarm                   → no-op (idempotent)
 *  - a connected org node is a live mgr   → refresh tokens from it, `join`
 *  - no live mgr, row has join material   → `join`; on failure re-elect (`init`)
 *  - org has no usable swarm              → `init` this node (becomes manager)
 */
export async function orchestrateSwarmMembership(args: OrchestrateArgs): Promise<OrchestrateOutcome> {
  const { db, hub, orgId, nodeId } = args;
  const role: 'manager' | 'worker' = args.roleHint === 'manager' ? 'manager' : 'worker';
  const peers = () => (args.peers?.() ?? []).filter((p) => p.nodeId !== nodeId);

  let plan: SwarmPlan;
  for (let defers = 0; ; defers++) {
    const cfg = await db.swarmConfig.findUnique({ where: { orgId } });
    plan = planSwarmMembership({
      alreadyInSwarm: Boolean(args.alreadyInSwarm),
      online: hub.isOnline(nodeId),
      role,
      cfg,
      peers: peers(),
      defers,
    });
    if (plan.kind !== 'defer') break;
    setStatus(args, 'waiting', plan.reason);
    await new Promise((r) => setTimeout(r, args.deferDelayMs ?? 5_000));
  }

  if (plan.kind === 'noop') return { action: 'noop', reason: plan.reason };

  try {
    if (plan.kind === 'join-live') return await joinViaLiveManager(args, plan.managerNodeId, role);
    if (plan.kind === 'init') return await initHere(args, plan.reelect, plan.reason);

    // join-stored: the row may be stale — a failure here means "manager dead".
    setStatus(args, 'joining', `joining the recorded manager at ${plan.managerAddr}`);
    try {
      const res = await dispatchJoin(args, role, decryptSecret(plan.tokenEnc), plan.managerAddr);
      setStatus(args, 'joined', `joined as ${role} via ${plan.managerAddr}`);
      return { action: 'join', role, swarmNodeId: res.swarmNodeId };
    } catch (e) {
      if (!hub.isOnline(nodeId)) throw e;
      const next = planAfterStoredJoinFailure(role, peers());
      console.warn(
        `[swarm] node ${nodeId}: join to recorded manager ${plan.managerAddr} failed (${errMsg(e)}) — ` +
          (next.kind === 'init' ? 're-electing' : 'retrying via a live manager'),
      );
      if (next.kind === 'join-live') return await joinViaLiveManager(args, next.managerNodeId, role);
      return await initHere(args, true, `${next.reason} (join to ${plan.managerAddr} failed: ${errMsg(e)})`);
    }
  } catch (e) {
    setStatus(args, 'failed', errMsg(e));
    throw e;
  }
}

async function dispatchJoin(
  args: OrchestrateArgs,
  role: 'manager' | 'worker',
  joinToken: string,
  managerAddr: string,
  nodeId = args.nodeId,
  advertiseAddr = args.meshIp ?? undefined,
): Promise<SwarmJoinResultLike> {
  return args.hub.dispatch<SwarmJoinResultLike>(
    nodeId,
    SWARM_COMMAND,
    {
      mode: 'join',
      role,
      joinToken,
      managerAddr,
      advertiseAddr,
      // Mesh-first join: pin VXLAN to the mesh too (Docker would default it to
      // the advertise addr anyway — explicit so it can never drift to the LAN).
      ...(advertiseAddr && advertiseAddr === args.meshIp ? { dataPathAddr: advertiseAddr } : {}),
    },
    { timeoutMs: SWARM_DISPATCH_TIMEOUT_MS },
  );
}

/**
 * Pull the CURRENT join tokens + advertise addr from a live manager (a
 * `refreshOnly` init: read-only on an active swarm, refused by the agent
 * otherwise), store them — self-healing a stale row — and join.
 */
async function joinViaLiveManager(
  args: OrchestrateArgs,
  managerNodeId: string,
  role: 'manager' | 'worker',
): Promise<OrchestrateOutcome> {
  setStatus(args, 'joining', `fetching join tokens from live manager ${managerNodeId}`);
  const { token, managerAddr } = await fetchLiveJoinMaterial(args, managerNodeId, role);
  const res = await dispatchJoin(args, role, token, managerAddr);
  setStatus(args, 'joined', `joined as ${role} via live manager at ${managerAddr}`);
  return { action: 'join', role, swarmNodeId: res.swarmNodeId };
}

/**
 * Read the CURRENT join token + manager address off a live manager and
 * re-store them (self-healing a stale row). Shared by onboarding joins and the
 * mesh migration's rejoin (`mesh-migration.service.ts`).
 */
export async function fetchLiveJoinMaterial(
  args: Pick<OrchestrateArgs, 'db' | 'hub' | 'orgId'>,
  managerNodeId: string,
  role: 'manager' | 'worker',
): Promise<{ token: string; managerAddr: string }> {
  const { db, hub, orgId } = args;
  const fresh = await hub.dispatch<SwarmJoinResultLike>(
    managerNodeId,
    SWARM_COMMAND,
    { mode: 'init', refreshOnly: true },
    { timeoutMs: SWARM_REFRESH_TIMEOUT_MS },
  );
  const token = role === 'manager' ? fresh.joinTokens?.manager : fresh.joinTokens?.worker;
  if (!token || !fresh.managerAddr) {
    throw new Error(`live manager ${managerNodeId} returned no ${role} join token / address`);
  }
  const update: Partial<SwarmConfigRow> = {
    ...(fresh.swarmNodeId ? { swarmId: fresh.swarmNodeId } : {}),
    managerNodeId,
    managerAddr: fresh.managerAddr,
    workerJoinTokenEnc: fresh.joinTokens?.worker ? encryptSecret(fresh.joinTokens.worker) : null,
    managerJoinTokenEnc: fresh.joinTokens?.manager ? encryptSecret(fresh.joinTokens.manager) : null,
  };
  await db.swarmConfig.upsert({
    where: { orgId },
    create: { orgId, swarmId: null, unlockKeyEnc: null, ...update } as SwarmConfigRow,
    update,
  });
  return { token, managerAddr: fresh.managerAddr };
}

/** `init` on this node, (over)write the org row, then pull in stranded peers. */
async function initHere(args: OrchestrateArgs, reelect: boolean, reason: string): Promise<OrchestrateOutcome> {
  const { db, hub, orgId, nodeId, meshIp } = args;
  const res = await hub.dispatch<SwarmJoinResultLike>(
    nodeId,
    SWARM_COMMAND,
    { mode: 'init', advertiseAddr: meshIp ?? undefined },
    { timeoutMs: SWARM_DISPATCH_TIMEOUT_MS },
  );
  const tokens = res.joinTokens ?? { worker: '', manager: '' };
  // Replacing the WHOLE row clears any stale manager addr / tokens; the unlock
  // key belonged to the old swarm and is meaningless for the new one.
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
  setStatus(args, reelect ? 'reelected' : 'initialised', reason);

  // Connected peers that are off-swarm (e.g. stranded behind the dead manager
  // and already failed their own join) are pulled into the new swarm now —
  // otherwise they'd sit idle until their next re-register.
  if (tokens.worker && res.managerAddr) {
    for (const p of (args.peers?.() ?? []).filter((x) => x.nodeId !== nodeId && x.swarmState === 'inactive')) {
      void dispatchJoin(args, 'worker', tokens.worker, res.managerAddr, p.nodeId, undefined)
        .then(() => statusByNode.set(p.nodeId, { state: 'joined', detail: `joined as worker via ${res.managerAddr}`, at: new Date().toISOString() }))
        .catch((e) => {
          console.warn(`[swarm] node ${p.nodeId}: join to new swarm failed: ${errMsg(e)}`);
        });
    }
  }
  // The node's swarm id + role are Docker truth (read via `hub.swarmNodeIdFor`/
  // `nodeInfoFor`) — never written back to the Node row.
  return reelect
    ? { action: 'init', swarmNodeId: res.swarmNodeId, reelected: true }
    : { action: 'init', swarmNodeId: res.swarmNodeId };
}
