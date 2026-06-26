import type { ServerWebSocket } from 'bun';

export interface AgentWsData {
  state: 'await_register' | 'ready';
  nodeId?: string;
  orgId?: string;
  openedAt: number;
}

export type AgentSocket = ServerWebSocket<AgentWsData>;

/** Tracks the live agent connection per node (newer wins). */
export class ConnectionRegistry {
  private byNode = new Map<string, AgentSocket>();

  add(nodeId: string, ws: AgentSocket): AgentSocket | undefined {
    const existing = this.byNode.get(nodeId);
    this.byNode.set(nodeId, ws);
    return existing && existing !== ws ? existing : undefined;
  }

  remove(nodeId: string, ws: AgentSocket): void {
    if (this.byNode.get(nodeId) === ws) this.byNode.delete(nodeId);
  }

  get(nodeId: string): AgentSocket | undefined {
    return this.byNode.get(nodeId);
  }

  isOnline(nodeId: string): boolean {
    const ws = this.byNode.get(nodeId);
    return !!ws && ws.readyState === 1;
  }

  onlineNodeIds(): string[] {
    return [...this.byNode.keys()].filter((id) => this.isOnline(id));
  }

  send(nodeId: string, frame: unknown): boolean {
    const ws = this.byNode.get(nodeId);
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }
}
