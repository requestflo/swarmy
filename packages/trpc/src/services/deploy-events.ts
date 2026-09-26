/**
 * In-memory deploy-event bus (the Deploying screen's live tracker + log).
 *
 * A traced deploy gets an id (`dep_…`) bound to its org and stack. Events
 * arrive from two places: the agent's `deployProgress` frames (relayed by the
 * gateway, which checks the sending node belongs to the same org) and the
 * controller's own stages (managed data, route + certificate, health). Each
 * deploy keeps a short ring (last 500 events, dropped 30 min after its last
 * event) so a subscriber that joins late gets a replay, plus a pub/sub for
 * the live tail. Same shape as `buildLogBus`; no DB, nothing persisted.
 *
 * Org scoping is enforced HERE for reads (`get` / `subscribe` take the
 * caller's org) so a caller can't forget it.
 */
import { randomBytes } from 'node:crypto';
import type { DeployProgressPayload } from '@swarmy/core/protocol';

export type DeployEvent = DeployProgressPayload & { seq: number };

export interface DeployTraceView {
  deployId: string;
  stack: string;
  startedAt: number;
  done: boolean;
  events: DeployEvent[];
}

const MAX_EVENTS = 500;
const MAX_DEPLOYS = 256;
const TTL_MS = 30 * 60_000;

interface Trace {
  orgId: string;
  stack: string;
  startedAt: number;
  touchedAt: number;
  seq: number;
  done: boolean;
  events: DeployEvent[];
  listeners: Set<(e: DeployEvent | null) => void>;
}

export class DeployEventBus {
  private traces = new Map<string, Trace>();
  constructor(private now: () => number = Date.now) {}

  /** Start a trace; returns its id. */
  begin(orgId: string, stack: string): string {
    this.sweep();
    if (this.traces.size >= MAX_DEPLOYS) {
      const oldest = this.traces.keys().next().value;
      if (oldest) this.traces.delete(oldest);
    }
    const id = `dep_${randomBytes(10).toString('hex')}`;
    const t = this.now();
    this.traces.set(id, { orgId, stack, startedAt: t, touchedAt: t, seq: 0, done: false, events: [], listeners: new Set() });
    return id;
  }

  /**
   * Append an event. `orgId` is the sender's org (the agent's node org, or
   * the controller's own ctx): an unknown id, another org's deploy or a
   * mismatched stack is dropped. Returns whether it was kept.
   */
  push(orgId: string, e: DeployProgressPayload): boolean {
    const t = this.traces.get(e.deployId);
    if (!t || t.orgId !== orgId || t.stack !== e.stack) return false;
    const ev: DeployEvent = { ...e, seq: ++t.seq };
    t.events.push(ev);
    if (t.events.length > MAX_EVENTS) t.events.shift();
    t.touchedAt = this.now();
    for (const fn of [...t.listeners]) fn(ev);
    return true;
  }

  /** The deploy finished (live, failed or gave up watching): subscribers end. */
  finish(deployId: string): void {
    const t = this.traces.get(deployId);
    if (!t || t.done) return;
    t.done = true;
    t.touchedAt = this.now();
    for (const fn of [...t.listeners]) fn(null);
  }

  /** The buffered trace, only for its own org (null otherwise, or once expired). */
  get(orgId: string, deployId: string): DeployTraceView | null {
    this.sweep();
    const t = this.traces.get(deployId);
    if (!t || t.orgId !== orgId) return null;
    return { deployId, stack: t.stack, startedAt: t.startedAt, done: t.done, events: [...t.events] };
  }

  /** Live events (and `null` once finished). Pair with `get` for the replay. */
  subscribe(orgId: string, deployId: string, fn: (e: DeployEvent | null) => void): (() => void) | null {
    const t = this.traces.get(deployId);
    if (!t || t.orgId !== orgId) return null;
    t.listeners.add(fn);
    return () => t.listeners.delete(fn);
  }

  private sweep(): void {
    const cutoff = this.now() - TTL_MS;
    for (const [id, t] of this.traces) {
      if (t.touchedAt < cutoff && t.listeners.size === 0) this.traces.delete(id);
    }
  }
}

/** Process-wide singleton shared by the gateway relay, the deploy paths and the router. */
export const deployEventBus = new DeployEventBus();
