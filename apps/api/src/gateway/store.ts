import type { ContainerInfo } from '@swarmy/core/protocol';
import type {
  ContainerStatsSnapshot,
  LogLine,
  NodeStatsSnapshot,
  ServiceStateSnapshot,
} from '@swarmy/core/views';

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(value: T): void {
    for (const fn of [...this.listeners]) fn(value);
  }
}

/** Bounded async iterable fed by an emitter; closes on abort. */
export function asyncQueue<T>(signal: AbortSignal): {
  push: (v: T) => void;
  close: () => void;
  iterator: AsyncGenerator<T>;
} {
  const buffer: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const close = () => {
    done = true;
    wake?.();
    wake = null;
  };
  if (signal.aborted) done = true;
  else signal.addEventListener('abort', close, { once: true });

  async function* gen(): AsyncGenerator<T> {
    while (!done) {
      if (buffer.length === 0) {
        await new Promise<void>((r) => {
          wake = r;
        });
        if (done) break;
      }
      while (buffer.length) yield buffer.shift() as T;
    }
  }
  return {
    push: (v: T) => {
      if (done) return;
      buffer.push(v);
      wake?.();
      wake = null;
    },
    close,
    iterator: gen(),
  };
}

/** In-memory snapshot rings + pub/sub for live subscriptions (no Postgres). */
export class GatewayStore {
  readonly nodeStats = new Map<string, NodeStatsSnapshot>();
  readonly containers = new Map<string, ContainerInfo[]>();
  readonly containerStats = new Map<string, ContainerStatsSnapshot[]>();
  readonly serviceState = new Map<string, ServiceStateSnapshot[]>();
  readonly nodeOrg = new Map<string, string>();
  readonly nodeCpuCount = new Map<string, number>();

  readonly nodeStatsEvent = new Emitter<{ nodeId: string; snap: NodeStatsSnapshot }>();
  readonly logEvent = new Emitter<{ commandId: string; line: LogLine }>();

  setNodeStats(nodeId: string, snap: NodeStatsSnapshot): void {
    this.nodeStats.set(nodeId, snap);
    this.nodeStatsEvent.emit({ nodeId, snap });
  }

  nodesForOrg(orgId: string): string[] {
    return [...this.nodeOrg.entries()].filter(([, o]) => o === orgId).map(([id]) => id);
  }

  serviceStatesForOrg(orgId: string): ServiceStateSnapshot[] {
    const out: ServiceStateSnapshot[] = [];
    for (const nodeId of this.nodesForOrg(orgId)) {
      out.push(...(this.serviceState.get(nodeId) ?? []));
    }
    return out;
  }

  forget(nodeId: string): void {
    this.nodeStats.delete(nodeId);
    this.containers.delete(nodeId);
    this.containerStats.delete(nodeId);
    this.serviceState.delete(nodeId);
  }
}
