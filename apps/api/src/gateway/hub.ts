import { PROTOCOL_VERSION, type ContainerInfo, type TermTarget } from '@swarmy/core/protocol';
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
  type AgentHub,
  type CommandName,
} from '@swarmy/trpc';
import { asyncQueue, GatewayStore } from './store';
import { ConnectionRegistry } from './registry';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function frame(type: string, payload: unknown) {
  return { v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: Date.now(), type, payload };
}

export class AgentHubImpl implements AgentHub {
  private pending = new Map<string, Pending>();

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
  }): { ticket: string; expiresAt: number } {
    return terminalHub.mintTicket(input);
  }

  /** Called by the protocol handler when a `commandResult` arrives. */
  settleCommand(commandId: string, ok: boolean, data?: unknown, error?: { message: string }): void {
    const p = this.pending.get(commandId);
    if (!p) return;
    this.pending.delete(commandId);
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
    const commandId = crypto.randomUUID();
    const type = COMMAND_PROTOCOL_TYPE[cmd];
    const body = { ...(payload as Record<string, unknown>), commandId };
    const promise = new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(new Error('command timeout'));
      }, opts?.timeoutMs ?? 15_000);
      this.pending.set(commandId, {
        resolve: (v) => resolve(v as R),
        reject,
        timer,
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
