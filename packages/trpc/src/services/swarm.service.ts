/**
 * Swarm orchestration (node-onboarding epic, PHASE-2+).
 *
 * Decides, when a node comes online, whether the org's Docker Swarm needs to be
 * initialised (this is the FIRST node) or whether the node should join an
 * existing swarm — then dispatches the single `swarmJoin` command to the agent,
 * which runs `docker swarm init` / `docker swarm join` locally.
 *
 * Docker is the source of truth for the swarm (epic-docker-native-state P1):
 * the swarm id, manager address and join tokens are read from a LIVE manager
 * (a `refreshOnly` init: `docker info` + `swarm join-token -q`) whenever a node
 * joins. Nothing is stored in the database. The last material a manager
 * returned is cached in process memory ({@link SwarmJoinStore}), ENCRYPTED
 * with the vault key, so a node can still join while the manager's agent is
 * briefly disconnected. It is never returned to clients.
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
  /** Live local swarm membership (agent-reported); lets the retry loop see a join that landed. */
  swarmStateFor?(nodeId: string): string | undefined;
  dispatch<R = unknown>(
    nodeId: string,
    cmd: CommandName,
    payload: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<R>;
}

/**
 * The last join material a live manager returned for an org, cached in
 * process memory (never the database). Tokens stay vault-encrypted even here.
 */
export interface SwarmJoinMaterial {
  orgId: string;
  swarmId: string | null;
  managerNodeId: string | null;
  managerAddr: string | null;
  /** Encrypted Docker worker join token (`SWMTKN-…`). */
  workerJoinTokenEnc: string | null;
  /** Encrypted Docker manager join token (`SWMTKN-…`). */
  managerJoinTokenEnc: string | null;
}

/** Where the cached join material lives (process memory by default; a stub in tests). */
export interface SwarmJoinStore {
  get(orgId: string): SwarmJoinMaterial | null;
  set(orgId: string, row: SwarmJoinMaterial): void;
}

const joinMaterial = new Map<string, SwarmJoinMaterial>();

/** The process-local join-material cache. */
export const memorySwarmJoinStore: SwarmJoinStore = {
  get: (orgId) => joinMaterial.get(orgId) ?? null,
  set: (orgId, row) => void joinMaterial.set(orgId, row),
};

/**
 * Prime the cache with join material known at boot (the installer passes node
 * #1's tokens as env), so the second node can join even before node #1's
 * agent has dialled back in. Plaintext tokens are encrypted here.
 */
export function primeSwarmJoinMaterial(input: {
  orgId: string;
  swarmId?: string | null;
  managerAddr?: string | null;
  workerToken?: string | null;
  managerToken?: string | null;
}): void {
  memorySwarmJoinStore.set(input.orgId, {
    orgId: input.orgId,
    swarmId: input.swarmId ?? null,
    managerNodeId: null,
    managerAddr: input.managerAddr ?? null,
    workerJoinTokenEnc: input.workerToken ? encryptSecret(input.workerToken) : null,
    managerJoinTokenEnc: input.managerToken ? encryptSecret(input.managerToken) : null,
  });
}

/**
 * The minimal Prisma surface this service uses: whether the org already has
 * other enrolled nodes (so a swarm exists somewhere, even if no manager is
 * connected right now).
 */
export interface SwarmDb {
  node: {
    count(args: { where: { orgId: string; id: { not: string } } }): Promise<number>;
  };
  /** The vault row holding the escrowed autolock unlock key (cleared on re-elect). */
  vaultEntry?: {
    deleteMany(args: { where: { orgId: string; name: string } }): Promise<unknown>;
  };
}

/** `VaultEntry.name` of the opt-in escrowed swarm autolock unlock key (`SWMKEY-…`). */
export const SWARM_UNLOCK_KEY_ENTRY = 'swarm.unlockKey';

/** Result of `swarmJoin` as it arrives in `commandResult.result`. */
interface SwarmJoinResultLike {
  mode: 'init' | 'join' | 'refresh';
  swarmNodeId: string;
  managerAddr?: string;
  joinTokens?: { worker: string; manager: string };
}

/**
 * A CONNECTED org peer of the registering node, as the gateway sees it. The
 * orchestrator never trusts cached join material alone: whether a manager is
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
  /** Absent ⇒ the org is treated as having no other enrolled nodes (tests). */
  db?: SwarmDb;
  hub: SwarmHub;
  /** Join-material cache (defaults to process memory). */
  joinStore?: SwarmJoinStore;
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
   * a live manager always wins over cached material (never `init` a second
   * swarm next to it), and cached material with no live manager is re-elected.
   * Absent ⇒ treated as "no peers" (legacy callers / tests).
   */
  peers?: () => SwarmPeer[];
  /** Observer for state transitions (audit/log). Must not throw. */
  onEvent?: (e: SwarmOrchestrationEvent) => void;
  /** Test seam: delay between deferred re-plans (default 5s). */
  deferDelayMs?: number;
  /** Internal: which attempt this is (1 = on register; >1 = the retry loop). */
  attempt?: number;
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
/**
 * Max times we wait for a manager of a KNOWN swarm (the org has other enrolled
 * nodes, but no manager agent is connected and nothing is cached, e.g. just
 * after a controller restart) before re-electing. 12 × 5 s = one minute.
 */
export const MAX_MANAGER_WAIT_DEFERS = 12;

// ── Pure decision logic (unit-tested) ────────────────────────────────────────

export interface SwarmPlanInput {
  alreadyInSwarm: boolean;
  online: boolean;
  role: 'manager' | 'worker';
  /** Join material a live manager last returned (process memory), if any. */
  cfg: SwarmJoinMaterial | null;
  /** The org has other enrolled nodes: a swarm exists, even if no manager is connected. */
  knownSwarm?: boolean;
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
  /** No live manager visible, but cached join material exists: try it; if
   *  the join fails the cached manager is dead → re-elect (init here). */
  | { kind: 'join-stored'; role: 'manager' | 'worker'; managerAddr: string; tokenEnc: string }
  /** No usable swarm: init here. `reelect` = replacing a dead swarm. */
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
 * that is exactly how a rejoining worker formed a standalone swarm. Cached
 * material is only a fallback: a live manager's fresh tokens beat it, and a
 * known swarm whose managers stay away past the wait is re-elected.
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

  const tokenEnc = role === 'manager' ? cfg?.managerJoinTokenEnc : cfg?.workerJoinTokenEnc;
  if (tokenEnc && cfg?.managerAddr) {
    return { kind: 'join-stored', role, managerAddr: cfg.managerAddr, tokenEnc };
  }
  if (input.knownSwarm || cfg?.swarmId) {
    if (input.defers < MAX_MANAGER_WAIT_DEFERS) {
      return { kind: 'defer', reason: 'waiting for a swarm manager of this org to connect' };
    }
    return {
      kind: 'init',
      reelect: true,
      reason: 'the org has a swarm but no manager connected in time — starting a new swarm here',
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
  try {
    const out = await orchestrateOnce(args);
    joinRetries.delete(args.nodeId);
    return out;
  } catch (e) {
    scheduleSwarmJoinRetry(args, e);
    throw e;
  }
}

async function orchestrateOnce(args: OrchestrateArgs): Promise<OrchestrateOutcome> {
  const { db, hub, orgId, nodeId } = args;
  const store = args.joinStore ?? memorySwarmJoinStore;
  const role: 'manager' | 'worker' = args.roleHint === 'manager' ? 'manager' : 'worker';
  const peers = () => (args.peers?.() ?? []).filter((p) => p.nodeId !== nodeId);
  const knownSwarm = db
    ? (await db.node.count({ where: { orgId, id: { not: nodeId } } }).catch(() => 0)) > 0
    : false;

  let plan: SwarmPlan;
  for (let defers = 0; ; defers++) {
    plan = planSwarmMembership({
      alreadyInSwarm: Boolean(args.alreadyInSwarm),
      online: hub.isOnline(nodeId),
      role,
      cfg: store.get(orgId),
      knownSwarm,
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

    // join-stored: the cache may be stale — a failure here means "manager dead".
    setStatus(args, 'joining', `joining the last known manager at ${plan.managerAddr}`);
    try {
      const res = await dispatchJoin(args, role, decryptSecret(plan.tokenEnc), plan.managerAddr);
      setStatus(args, 'joined', `joined as ${role} via ${plan.managerAddr}`);
      return { action: 'join', role, swarmNodeId: res.swarmNodeId };
    } catch (e) {
      if (!hub.isOnline(nodeId)) throw e;
      const next = planAfterStoredJoinFailure(role, peers());
      console.warn(
        `[swarm] node ${nodeId}: join to last known manager ${plan.managerAddr} failed (${errMsg(e)}) — ` +
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

// ── Retry: a registered node that isn't in the swarm yet ──────────────────────
//
// Registration dispatches `swarm.join` once. A fresh peer whose first path to
// the manager is slow (a relayed mesh link still settling, a manager busy
// electing) times out, and before this nothing retried until the agent
// restarted. Failed memberships are now re-planned + re-sent by a reconcile
// tick (workers/swarm-join-retry.ts) with backoff, until the node joins or
// SWARM_JOIN_MAX_ATTEMPTS fail — then the node shows
// "couldn't join the cluster: <reason>". A re-register starts over.

/** Waits before retry 2, 3, … (after attempt 1 on register). */
export const SWARM_JOIN_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 240_000] as const;
export const SWARM_JOIN_MAX_ATTEMPTS = SWARM_JOIN_BACKOFF_MS.length + 1;

interface JoinRetry {
  args: OrchestrateArgs;
  /** Attempts made so far. */
  attempts: number;
  nextAt: number;
  lastError: string;
  inFlight: boolean;
}
const joinRetries = new Map<string, JoinRetry>();

/** Pure: when the next attempt runs after `attempts` failed ones, or null when exhausted. */
export function nextSwarmJoinAttemptAt(attempts: number, failedAt: number): number | null {
  if (attempts >= SWARM_JOIN_MAX_ATTEMPTS) return null;
  const wait = SWARM_JOIN_BACKOFF_MS[Math.min(attempts - 1, SWARM_JOIN_BACKOFF_MS.length - 1)]!;
  return failedAt + wait;
}

function scheduleSwarmJoinRetry(args: OrchestrateArgs, e: unknown, now = Date.now()): void {
  const attempts = args.attempt ?? 1;
  const reason = errMsg(e);
  const nextAt = nextSwarmJoinAttemptAt(attempts, now);
  if (nextAt === null) {
    joinRetries.delete(args.nodeId);
    setStatus(args, 'failed', `couldn't join the cluster: ${reason} (gave up after ${attempts} attempts; restart the agent or re-run its install line to try again)`);
    return;
  }
  const { attempt: _a, ...base } = args;
  joinRetries.set(args.nodeId, { args: base, attempts, nextAt, lastError: reason, inFlight: false });
  setStatus(
    args,
    'failed',
    `join attempt ${attempts}/${SWARM_JOIN_MAX_ATTEMPTS} failed: ${reason} — retrying in ${Math.round((nextAt - now) / 1000)}s`,
  );
}

/** Nodes waiting for a join retry (test seam + diagnostics). */
export function pendingSwarmJoins(): { nodeId: string; attempts: number; nextAt: number; lastError: string }[] {
  return [...joinRetries.entries()].map(([nodeId, r]) => ({ nodeId, attempts: r.attempts, nextAt: r.nextAt, lastError: r.lastError }));
}

/** Test seam. */
export function clearSwarmJoinRetries(): void {
  joinRetries.clear();
}

/**
 * One reconcile tick: re-run membership for every due node. A node that joined
 * by other means (or reports an active swarm) is cleared; an offline node
 * waits (its re-register starts over anyway). Never throws.
 */
export async function retryPendingSwarmJoins(now = Date.now()): Promise<{ retried: string[]; joined: string[]; skipped: string[] }> {
  const out = { retried: [] as string[], joined: [] as string[], skipped: [] as string[] };
  for (const [nodeId, r] of [...joinRetries.entries()]) {
    const hub = r.args.hub;
    if (hub.swarmStateFor?.(nodeId) === 'active') {
      joinRetries.delete(nodeId);
      setStatus(r.args, 'joined', 'in the swarm');
      out.joined.push(nodeId);
      continue;
    }
    if (r.inFlight || now < r.nextAt || !hub.isOnline(nodeId)) {
      out.skipped.push(nodeId);
      continue;
    }
    r.inFlight = true;
    out.retried.push(nodeId);
    setStatus(r.args, 'joining', `retrying the swarm join (attempt ${r.attempts + 1}/${SWARM_JOIN_MAX_ATTEMPTS}; last error: ${r.lastError})`);
    try {
      await orchestrateSwarmMembership({ ...r.args, alreadyInSwarm: false, attempt: r.attempts + 1 });
      out.joined.push(nodeId);
    } catch {
      // scheduleSwarmJoinRetry already recorded the next attempt (or gave up).
    } finally {
      const cur = joinRetries.get(nodeId);
      if (cur) cur.inFlight = false;
    }
  }
  return out;
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
 * otherwise), cache them in memory and join.
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
 * Read the CURRENT join token + manager address off a live manager (Docker
 * truth) and refresh the in-memory cache (onboarding joins).
 */
export async function fetchLiveJoinMaterial(
  args: Pick<OrchestrateArgs, 'db' | 'hub' | 'orgId' | 'joinStore'>,
  managerNodeId: string,
  role: 'manager' | 'worker',
): Promise<{ token: string; managerAddr: string }> {
  const { hub, orgId } = args;
  const store = args.joinStore ?? memorySwarmJoinStore;
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
  store.set(orgId, {
    orgId,
    swarmId: fresh.swarmNodeId ?? store.get(orgId)?.swarmId ?? null,
    managerNodeId,
    managerAddr: fresh.managerAddr,
    workerJoinTokenEnc: fresh.joinTokens?.worker ? encryptSecret(fresh.joinTokens.worker) : null,
    managerJoinTokenEnc: fresh.joinTokens?.manager ? encryptSecret(fresh.joinTokens.manager) : null,
  });
  return { token, managerAddr: fresh.managerAddr };
}

/** `init` on this node, replace the cached material, then pull in stranded peers. */
async function initHere(args: OrchestrateArgs, reelect: boolean, reason: string): Promise<OrchestrateOutcome> {
  const { hub, orgId, nodeId, meshIp } = args;
  const res = await hub.dispatch<SwarmJoinResultLike>(
    nodeId,
    SWARM_COMMAND,
    { mode: 'init', advertiseAddr: meshIp ?? undefined },
    { timeoutMs: SWARM_DISPATCH_TIMEOUT_MS },
  );
  const tokens = res.joinTokens ?? { worker: '', manager: '' };
  // Replacing the WHOLE entry clears any stale manager addr / tokens.
  (args.joinStore ?? memorySwarmJoinStore).set(orgId, {
    orgId,
    swarmId: res.swarmNodeId,
    managerNodeId: nodeId,
    managerAddr: res.managerAddr ?? null,
    workerJoinTokenEnc: tokens.worker ? encryptSecret(tokens.worker) : null,
    managerJoinTokenEnc: tokens.manager ? encryptSecret(tokens.manager) : null,
  });
  // An escrowed unlock key belonged to the old swarm and can't unlock this one.
  await args.db?.vaultEntry
    ?.deleteMany({ where: { orgId, name: SWARM_UNLOCK_KEY_ENTRY } })
    .catch(() => undefined);
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
