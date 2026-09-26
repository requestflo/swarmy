import {
  DEFAULT_COMMAND_TIMEOUTS,
  PROGRESS_IDLE_TIMEOUT_MS,
  PROGRESS_MAX_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type CommandProgress,
  type ContainerInfo,
  type SwarmServiceInfo,
  type SwarmNodeInfo,
  type SwarmState,
  type TermTarget,
} from '@swarmy/core/protocol';
import { terminalHub } from '../terminal';
import type {
  ClusterStatsFrame,
  ContainerStatsSnapshot,
  LogLine,
  NodeStatsSnapshot,
  ServiceStateSnapshot,
} from '@swarmy/core/views';
import {
  COMMAND_PROTOCOL_TYPE,
  gateSystemDeploy,
  type AgentHub,
  type CommandName,
  type DispatchDecorator,
} from '@swarmy/trpc';
import type { EdgeTrafficRing } from '@swarmy/core';
import { asyncQueue, GatewayStore } from './store';
import { pickCommandId } from './command-id';
import { ConnectionRegistry } from './registry';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Base (idle) budget and dispatch time — progress frames re-arm from these. */
  timeoutMs: number;
  dispatchedAt: number;
  /** deployService only: where its progress shows on the service's deploy status. */
  deploy?: { orgId: string; service: string };
}

/** Key for {@link GatewayStore.deployProgress}. */
export function deployProgressKey(orgId: string, service: string): string {
  return `${orgId}\u0000${service}`;
}

function frame(type: string, payload: unknown) {
  return { v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: Date.now(), type, payload };
}

export class AgentHubImpl implements AgentHub {
  private pending = new Map<string, Pending>();
  private decorate: DispatchDecorator | undefined;

  constructor(
    readonly store: GatewayStore,
    readonly registry: ConnectionRegistry,
  ) {}

  isOnline(nodeId: string): boolean {
    return this.registry.isOnline(nodeId);
  }

  onlineNodeIds(): string[] {
    return this.registry.onlineNodeIds();
  }

  mintTerminalTicket(input: {
    sessionId: string;
    nodeId: string;
    orgId: string;
    userId: string;
    target: TermTarget;
    /** Controller capability read (isExecCapable / isNodeShellCapable) → `termStart.nodeCapable`. */
    nodeCapable?: boolean;
  }): { ticket: string; expiresAt: number } {
    return terminalHub.mintTicket(input);
  }

  /** Best-effort teardown of a live terminal session's data-plane socket. */
  killTerminalSession(sessionId: string): boolean {
    return terminalHub.killSession(sessionId);
  }

  /**
   * Install the payload hook every dispatch passes through (e.g. registry pull
   * auth for org-registry deploys). One place, so no call site can forget it.
   */
  setDispatchDecorator(fn: DispatchDecorator | undefined): void {
    this.decorate = fn;
  }

  /**
   * Called by the protocol handler on a non-terminal `running` frame carrying
   * `progress`: a heartbeat that re-arms the deadline (see
   * {@link progressDeadlineMs}) and records the phase for the deploy status.
   */
  commandProgress(commandId: string, progress: CommandProgress): void {
    const p = this.pending.get(commandId);
    if (!p) return;
    const now = Date.now();
    clearTimeout(p.timer);
    p.timer = setTimeout(
      () => this.expire(commandId),
      progressDeadlineMs(p.timeoutMs, p.dispatchedAt, now),
    );
    if (p.deploy) {
      this.store.deployProgress.set(deployProgressKey(p.deploy.orgId, p.deploy.service), {
        phase: progress.phase,
        message: progress.message ?? null,
        startedAt: p.dispatchedAt,
        at: now,
      });
    }
  }

  /** In-flight deploy progress for a service (e.g. "pulling image…"), if any. */
  deployProgress(
    orgId: string,
    service: string,
  ): { phase: CommandProgress['phase']; message: string | null; startedAt: number; at: number } | undefined {
    return this.store.deployProgress.get(deployProgressKey(orgId, service));
  }

  private expire(commandId: string): void {
    const p = this.pending.get(commandId);
    if (!p) return;
    this.pending.delete(commandId);
    this.clearDeployProgress(p);
    p.reject(new Error('command timeout'));
  }

  private clearDeployProgress(p: Pending): void {
    if (p.deploy) this.store.deployProgress.delete(deployProgressKey(p.deploy.orgId, p.deploy.service));
  }

  /** Called by the protocol handler when a `commandResult` arrives. */
  settleCommand(commandId: string, ok: boolean, data?: unknown, error?: { message: string }): void {
    const p = this.pending.get(commandId);
    if (!p) return;
    this.pending.delete(commandId);
    clearTimeout(p.timer);
    this.clearDeployProgress(p);
    if (ok) p.resolve(data);
    else p.reject(new Error(error?.message ?? 'command rejected'));
  }

  /** Called by the protocol handler when a `logChunk` arrives. */
  emitLog(commandId: string, line: LogLine): void {
    this.store.logEvent.emit({ commandId, line });
  }

  async dispatch<R = unknown>(
    nodeId: string,
    cmd: CommandName,
    payload: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<R> {
    if (!this.registry.isOnline(nodeId)) throw new Error(`node ${nodeId} is offline`);
    const orgId = this.store.nodeOrg.get(nodeId);
    if (this.decorate && orgId) {
      // Fail open: a decorator error must never block the command itself.
      payload = await this.decorate(orgId, cmd, payload).catch(() => payload);
    }
    if (cmd === 'service.deploy' && orgId) {
      // Every system-service converge (DNS, edge, collector, Garage, registry,
      // cache, mail, mesh control, app-auth, managed data…) is re-sent on each
      // tick and boot. Dispatch only a real change to the desired spec: a
      // no-op update still restarted every task (QA-049).
      const p = payload as Parameters<typeof gateSystemDeploy>[0];
      const live = p?.spec ? this.store.liveServicesForOrg(orgId).find((s) => s.name === p.spec.name) : undefined;
      const gate = p?.spec ? gateSystemDeploy(p, live) : { payload: p, skip: false };
      if (gate.skip && live) return { serviceId: live.id, created: false, unchanged: true } as R;
      payload = gate.payload;
    }
    const commandId = pickCommandId(payload, (id) => this.pending.has(id));
    const type = COMMAND_PROTOCOL_TYPE[cmd];
    const body = { ...(payload as Record<string, unknown>), commandId };
    const timeoutMs = commandTimeoutMs(type, opts?.timeoutMs);
    const deployName =
      type === 'deployService' ? (body as { spec?: { name?: unknown } }).spec?.name : undefined;
    const promise = new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => this.expire(commandId), timeoutMs);
      this.pending.set(commandId, {
        resolve: (v) => resolve(v as R),
        reject,
        timer,
        timeoutMs,
        dispatchedAt: Date.now(),
        deploy: orgId && typeof deployName === 'string' ? { orgId, service: deployName } : undefined,
      });
    });
    this.registry.send(nodeId, frame(type, body));
    return promise;
  }

  async *stream<T>(
    nodeId: string,
    _cmd: CommandName,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncIterable<T> {
    for await (const line of this.subscribeLogLines(nodeId, payload, signal)) {
      yield line as unknown as T;
    }
  }

  latestNodeStats(nodeId: string): NodeStatsSnapshot | undefined {
    return this.store.nodeStats.get(nodeId);
  }

  latestContainers(nodeId: string): ContainerInfo[] {
    return this.store.containers.get(nodeId) ?? [];
  }

  latestContainerStats(nodeId: string): ContainerStatsSnapshot[] {
    return this.store.containerStats.get(nodeId) ?? [];
  }

  latestServiceState(orgId: string): ServiceStateSnapshot[] {
    return this.store.serviceStatesForOrg(orgId);
  }

  /** Live Docker inventory for the org (services + containers) — read from memory, no DB. */
  liveInventory(orgId: string): { services: SwarmServiceInfo[]; containers: ContainerInfo[] } {
    return {
      services: this.store.liveServicesForOrg(orgId),
      containers: this.store.containersForOrg(orgId),
    };
  }

  /** A connected swarm-manager node id (Docker truth) to route write commands to. */
  managerNode(orgId: string): string | undefined {
    return this.store.managerNodeForOrg(orgId);
  }

  /** Live swarm node inventory (Docker-truth role/status/labels/resources) for the org.
   *  includeOffline folds in last-known nodes for disconnected-but-enrolled agents. */
  nodeInventory(orgId: string, includeOffline = false): SwarmNodeInfo[] {
    return this.store.nodeInventoryForOrg(orgId, includeOffline);
  }

  /** ALL connected swarm-manager node ids for the org (for fan-out / pick-any). */
  managerNodes(orgId: string): string[] {
    return this.store.managerNodeIdsForOrg(orgId);
  }

  /** Last-known services for the org (live + retained-on-disconnect) — dr-reconcile. */
  lastKnownServices(orgId: string): SwarmServiceInfo[] {
    return this.store.lastKnownServicesForOrg(orgId);
  }

  /** Last heartbeat time for a node (ms epoch), or undefined if never seen. */
  lastSeen(nodeId: string): number | undefined {
    return this.store.lastSeen.get(nodeId);
  }

  /** Docker swarm node id for a connected agent (via its reported hostname). */
  swarmNodeIdFor(controllerNodeId: string): string | undefined {
    return this.store.swarmNodeIdFor(controllerNodeId);
  }

  /** Full live swarm info (role/status/labels/resources) for an enrollment node id. */
  nodeInfoFor(controllerNodeId: string): SwarmNodeInfo | undefined {
    return this.store.nodeInfoFor(controllerNodeId);
  }

  /** Agent build (version + packaging) from the node's last register facts. */
  agentBuildFor(
    controllerNodeId: string,
  ): {
    version: string;
    /** Build commit from register facts (absent on agents that predate it). */
    commit?: string;
    packaging?: 'binary' | 'container';
    buildOverride?: 'allow' | 'deny';
    /** Local SWARMY_ALLOW_EXEC override from register facts (absent = unset). */
    execOverride?: 'allow' | 'deny';
    /** Local SWARMY_ALLOW_NODE_SHELL override from register facts (absent = unset). */
    shellOverride?: 'allow' | 'deny';
  } | undefined {
    return this.store.agentBuild.get(controllerNodeId);
  }

  /** Latest edge health telemetry for a node (geo-edge), if it has reported. */
  /** Per-edge request ring (Q4), fed by the agents' `metrics.edge`. */
  edgeTraffic(): EdgeTrafficRing {
    return this.store.edgeTraffic;
  }

  ingressStatusFor(
    controllerNodeId: string,
  ): { caddyRunning: boolean; dnsRunning: boolean; sampledAt: number } | undefined {
    return this.store.ingressNodeStatus.get(controllerNodeId);
  }

  /** Live local swarm membership of a node — `active` means a working member. */
  swarmStateFor(controllerNodeId: string): SwarmState | undefined {
    return this.store.swarmStateFor(controllerNodeId);
  }

  /** Controller node ids carrying a role label (swarmy.node.ingress/outlet = "true"). */
  nodesByRole(orgId: string, role: 'ingress' | 'outlet'): string[] {
    return this.store.nodesByRoleForOrg(orgId, role);
  }

  /** Region label (swarmy.region) → controller node ids in that region. */
  nodesByRegion(orgId: string): Map<string, string[]> {
    return this.store.nodesByRegionForOrg(orgId);
  }

  async *subscribeNodeStats(nodeId: string, signal: AbortSignal): AsyncIterable<NodeStatsSnapshot> {
    const q = asyncQueue<NodeStatsSnapshot>(signal);
    const current = this.store.nodeStats.get(nodeId);
    if (current) q.push(current);
    const off = this.store.nodeStatsEvent.on(({ nodeId: id, snap }) => {
      if (id === nodeId) q.push(snap);
    });
    try {
      yield* q.iterator;
    } finally {
      off();
    }
  }

  async *subscribeClusterStats(orgId: string, signal: AbortSignal): AsyncIterable<ClusterStatsFrame> {
    while (!signal.aborted) {
      yield this.clusterFrame(orgId);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async *subscribeLogLines(
    nodeId: string,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncIterable<LogLine> {
    const commandId = crypto.randomUUID();
    const q = asyncQueue<LogLine>(signal);
    const off = this.store.logEvent.on(({ commandId: cid, line }) => {
      if (cid === commandId) q.push(line);
    });
    this.registry.send(
      nodeId,
      frame('streamLogs', { ...(payload as Record<string, unknown>), commandId, action: 'start' }),
    );
    signal.addEventListener(
      'abort',
      () => {
        this.registry.send(nodeId, frame('streamLogs', { commandId, action: 'stop', target: (payload as { target?: unknown }).target }));
        off();
      },
      { once: true },
    );
    try {
      yield* q.iterator;
    } finally {
      off();
    }
  }

  private clusterFrame(orgId: string): ClusterStatsFrame {
    const nodeIds = this.store.nodesForOrg(orgId);
    const online = nodeIds.filter((id) => this.registry.isOnline(id));
    let cpuSum = 0;
    let memUsed = 0;
    let memTotal = 0;
    let counted = 0;
    let containers = 0;
    for (const id of online) {
      const s = this.store.nodeStats.get(id);
      if (s) {
        cpuSum += s.cpuPercent;
        memUsed += s.memUsedBytes;
        memTotal += s.memTotalBytes;
        counted += 1;
      }
      containers += this.store.containers.get(id)?.filter((c) => c.state === 'running').length ?? 0;
    }
    return {
      ts: Date.now(),
      nodesOnline: online.length,
      nodesTotal: nodeIds.length,
      cpuPercent: counted ? cpuSum / counted : 0,
      memUsedBytes: memUsed,
      memTotalBytes: memTotal,
      containersRunning: containers,
    };
  }
}

/** Fallback for commands with no entry in {@link DEFAULT_COMMAND_TIMEOUTS}. */
const FALLBACK_COMMAND_TIMEOUT_MS = 15_000;
/** setTimeout's ceiling (~24.8 days): "no deadline" commands still get one. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How long the hub waits for a command's result: the caller's explicit value,
 * else the per-command default (a deploy pulls images, an agent update
 * downloads + verifies a ~100 MB binary), else 15s. The table used to be dead
 * code, so EVERY command got 15s and slow-but-healthy ones reported
 * "command timeout" (found on the launch test: an arm64 agent update). `0` in
 * the table means "no deadline" (streams). Pure.
 */
/**
 * The re-armed deadline (ms from `now`) after a progress frame: at least the
 * command's own budget and {@link PROGRESS_IDLE_TIMEOUT_MS} of silence, but
 * never past {@link PROGRESS_MAX_TIMEOUT_MS} (or the base budget, if larger)
 * from dispatch. A pull that keeps moving survives; one that stalls fails. Pure.
 */
export function progressDeadlineMs(baseMs: number, dispatchedAt: number, now: number): number {
  const idle = Math.max(baseMs, PROGRESS_IDLE_TIMEOUT_MS);
  const ceilingAt = dispatchedAt + Math.max(baseMs, PROGRESS_MAX_TIMEOUT_MS);
  return Math.max(0, Math.min(idle, ceilingAt - now, MAX_TIMER_MS));
}

export function commandTimeoutMs(type: string, explicit?: number): number {
  const ms = explicit ?? DEFAULT_COMMAND_TIMEOUTS[type] ?? FALLBACK_COMMAND_TIMEOUT_MS;
  return ms <= 0 ? MAX_TIMER_MS : Math.min(ms, MAX_TIMER_MS);
}
