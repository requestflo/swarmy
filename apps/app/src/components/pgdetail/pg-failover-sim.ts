import { decideFailover, failoverPolicy, type FailoverDecision, type NodeSummary } from '@swarmy/core';
import type { PgMode, PgTopoMember } from './pg-topology';

/**
 * "Simulate <region> outage" (board 39): take the main copy's region (or its
 * server, when servers carry no region) away and run the reconcile worker's
 * own pure rule, `decideFailover`, on what survives. The dashboard never sees
 * replay positions (LSNs) — the worker measures them at that moment — so the
 * rule runs three ways: the best copy has every change, it trails by even one
 * byte, or swarmy has no reading of the main copy (the controller restarted).
 * Seconds of lag order the candidates but are never proof. PURE — tested.
 */

export interface OutageScope {
  /** "us-east" / "wkr-1". */
  label: string;
  kind: 'region' | 'server';
  serverIds: string[];
}

/** The main copy's region, else its server; null until placement is known. */
export function outageScope(primaryServers: NodeSummary[], nodes: NodeSummary[]): OutageScope | null {
  const p = primaryServers[0];
  if (!p) return null;
  if (p.region) return { label: p.region, kind: 'region', serverIds: nodes.filter((n) => n.region === p.region).map((n) => n.id) };
  return { label: p.name, kind: 'server', serverIds: [p.id] };
}

export interface OutageSim {
  scope: OutageScope;
  policy: 'never' | 'gated';
  /** Every server of the main copy is inside the outage. */
  primaryDown: boolean;
  /** Standby copies still running outside it, with their servers and last lag. */
  survivors: Array<{ service: string; servers: NodeSummary[]; lagSeconds: number | null }>;
  /** Standby copies that lose a server to the outage. */
  hit: number;
  caughtUp: FailoverDecision;
  behind: FailoverDecision;
  unknown: FailoverDecision;
}

/** A watermark and a replay position one byte short of it. */
const MARK = '0/3000000';
const ONE_SHORT = '0/2FFFFFF';

export function simulateOutage(
  topology: PgMode,
  members: PgTopoMember[],
  place: Map<string, NodeSummary[]>,
  scope: OutageScope,
  now: number,
): OutageSim {
  const out = new Set(scope.serverIds);
  const primaryServers = members.filter((m) => m.role === 'primary').flatMap((m) => place.get(m.service) ?? []);
  const primaryDown = primaryServers.length > 0 && primaryServers.every((n) => out.has(n.id));
  const replicas = members.filter((m) => m.role === 'replica');
  const survivors = replicas
    .map((m) => ({ service: m.service, servers: (place.get(m.service) ?? []).filter((n) => !out.has(n.id)), lagSeconds: m.lagSeconds ?? null }))
    .filter((s) => s.servers.length > 0);
  const hit = replicas.filter((m) => (place.get(m.service) ?? []).some((n) => out.has(n.id))).length;
  const decide = (replayLsn: string, known: boolean): FailoverDecision =>
    decideFailover({
      topology,
      // One candidate per surviving COPY (a service runs one per server), as the worker does.
      candidates: survivors.flatMap((s) => s.servers.map((n) => ({ service: s.service, copy: n.id, running: 1, replayLsn, lagSeconds: s.lagSeconds }))),
      watermark: known ? { lsn: MARK, sampledAt: now } : null,
      lastHealthyAt: known ? now : null,
      confirmation: null,
    });
  return {
    scope,
    policy: failoverPolicy(topology),
    primaryDown,
    survivors,
    hit,
    caughtUp: decide(MARK, true),
    behind: decide(ONE_SHORT, true),
    unknown: decide(MARK, false),
  };
}

export interface SimLine {
  tone: 'ok' | 'warn' | 'bad' | 'idle';
  lead: string;
  rest: string;
}

/** The verdict in plain words, one line per case the rule can take. */
export function simWords(sim: OutageSim, serverOf: (service: string) => string): SimLine[] {
  const where = sim.scope.kind === 'region' ? `${sim.scope.label} comes back` : `${sim.scope.label} is back`;
  if (!sim.primaryDown) {
    const reads = sim.hit ? ` ${sim.hit === 1 ? 'A standby copy there stops' : `${sim.hit} standby copies there stop`} serving reads until then.` : '';
    return [{ tone: 'ok', lead: `The main copy isn’t in ${sim.scope.label}, so nothing switches over.`, rest: reads.trim() }];
  }
  if (sim.caughtUp.kind === 'never') {
    return [{ tone: 'bad', lead: 'Nothing to switch over to.', rest: `The app stops saving changes until ${where}, or you put back the last save on another server.` }];
  }
  if (sim.caughtUp.kind !== 'promote') {
    return [{ tone: 'warn', lead: `No standby copy outside ${sim.scope.label} is running.`, rest: `swarmy waits for ${where}. Nothing is switched and nothing is lost.` }];
  }
  const copy = sim.caughtUp.copy;
  const to = sim.survivors.flatMap((s) => s.servers).find((n) => n.id === copy)?.name ?? serverOf(sim.caughtUp.target);
  return [
    { tone: 'ok', lead: `If the copy on ${to} has every change, it takes over by itself.`, rest: 'Nothing is lost, and the other copies follow the new main copy.' },
    {
      tone: 'warn',
      lead: 'If it trails by even one change, or swarmy lost its last reading of the main copy, it holds.',
      rest: `It opens an incident and asks an owner, showing exactly what could be lost. If ${where} first, nothing is lost.`,
    },
  ];
}
