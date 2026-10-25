import type { NodeSummary } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import type { FlowBox, FlowLink } from '@/components/stack-data/flow-diagram';
import type { PgClusterFacts, PgMember } from '@/components/stack-data/pg-choices';

/**
 * The per-database topology diagram (board 39) as boxes and lines, from
 * `db.get`'s members and lag plus which servers each member runs on. The
 * picked shape morphs it: a shape that drops the standby copies greys them
 * out, one that needs a copy that isn't there yet draws a dashed box. PURE —
 * tested in pg-topology.test.ts.
 */

export type PgMode = PgClusterFacts['topology'];

/** The shapes the picker previews (active-active shows only when a cluster already is one). */
export const PREVIEW_MODES: readonly PgMode[] = ['single', 'primary-replica', 'failover', 'geo'];

export const MODE_WORDS: Record<PgMode, { label: string; hint: string }> = {
  single: { label: 'One copy', hint: 'one server' },
  'primary-replica': { label: 'Standby copy', hint: 'the default' },
  failover: { label: 'Switch over by itself', hint: 'standby on another server' },
  geo: { label: 'Geo', hint: 'read near users' },
  'active-active': { label: 'Active-active', hint: 'every region writes' },
};

export type PgTopoMember = PgMember & { region?: string };

export interface PgTopoInput {
  /** The shape drawn (the picked preview). */
  mode: PgMode;
  current: PgMode;
  members: PgTopoMember[];
  /** Service name → servers; undefined while placement loads. */
  place: Map<string, NodeSummary[]> | undefined;
  /** A held switch-over's target (`pendingFailover.target`): the main copy is down. */
  heldTarget: string | null;
  /** Controls words (primary / replica / WAL) instead of Summary ones. */
  tech: boolean;
  /** `<service>@<nodeId>` → how far behind that copy is (`db.replication`), when read. */
  behind?: Map<string, { stat: string; warn: boolean }>;
}

/** `storefront_checkout-replica` → `checkout-replica`. */
export const shortName = (service: string): string => service.replace(/^[^_]*_/, '');

function statusTone(status: string): Tone {
  if (status === 'running') return 'ok';
  if (status === 'degraded') return 'warn';
  if (status === 'deploying') return 'info';
  return 'bad';
}

/** The member's servers, or one placeholder while placement loads. */
function hosts(m: PgTopoMember, place: PgTopoInput['place']): Array<NodeSummary | null> {
  if (!place) return [null];
  return place.get(m.service) ?? [];
}

export function pgTopology(i: PgTopoInput): { columns: FlowBox[][]; links: FlowLink[] } {
  const word = (main: boolean): string => (i.tech ? (main ? 'primary' : 'replica') : main ? 'main copy' : 'standby');
  const meta = (m: PgTopoMember, n: NodeSummary | null): string =>
    [n?.region ?? m.region, i.tech ? shortName(m.service) : null].filter(Boolean).join(' · ') || shortName(m.service);
  const down = i.heldTarget !== null;

  const primaries = i.members.filter((m) => m.role === 'primary');
  const left: FlowBox[] = primaries.flatMap((m) =>
    hosts(m, i.place).map((n) => ({
      key: `${m.service}@${n?.id ?? '-'}`,
      title: n?.name ?? shortName(m.service),
      chip: down ? 'down' : i.mode === 'active-active' ? 'writer' : word(true),
      chipTone: down ? 'bad' : 'info',
      meta: meta(m, n),
      stat: down ? 'not answering' : i.tech ? `${m.running}/${m.desired} running` : 'takes every write',
      tone: down ? 'bad' : statusTone(m.status),
    })),
  );
  const primaryHosts = new Set(primaries.flatMap((m) => (i.place?.get(m.service) ?? []).map((n) => n.id)));
  const primaryName = left[0]?.title ?? 'the main server';

  const right: FlowBox[] = [];
  const replicas = i.members.filter((m) => m.role === 'replica');
  const dropped = i.mode === 'single' || i.mode === 'active-active';
  for (const m of replicas) {
    const lag = m.lagSeconds;
    const servers = hosts(m, i.place);
    for (const n of servers) {
      const shared = !!n && primaryHosts.has(n.id);
      const moves = i.mode === 'failover' && shared;
      const read = n ? i.behind?.get(`${m.service}@${n.id}`) : undefined;
      right.push({
        key: `${m.service}@${n?.id ?? '-'}`,
        title: n?.name ?? shortName(m.service),
        chip: i.heldTarget === m.service ? 'held' : word(false),
        chipTone: i.heldTarget === m.service ? 'warn' : undefined,
        meta: meta(m, n),
        stat: dropped
          ? 'not in this shape'
          : moves
            ? `moves off ${primaryName}`
            : read && !i.tech
              ? read.stat
              : lag === undefined
              ? 'lag not measured yet'
              : i.tech
                ? `replay lag ${lag} s`
                : `${Math.round(lag)} s behind`,
        statTone: !dropped && (moves || (read ? read.warn : (lag ?? 0) >= 5)) ? 'warn' : undefined,
        tone: statusTone(m.status),
        ghost: dropped,
      });
    }
    const missing = m.desired - m.running;
    if (!dropped && missing > 0) {
      right.push({ key: `${m.service}@missing`, title: 'not running', meta: `${missing} of ${m.desired} ${m.desired === 1 ? 'copy' : 'copies'}`, tone: 'warn', ghost: true });
    }
  }
  if (!dropped && replicas.length === 0) {
    right.push({ key: 'add@standby', title: 'a standby copy', meta: i.mode === 'failover' ? `off ${primaryName} · added on apply` : 'added on apply', tone: 'idle', ghost: true });
  }
  if (i.mode === 'geo' && i.current !== 'geo') {
    right.push({ key: 'add@region', title: 'a copy in another region', meta: 'you pick the read regions', tone: 'idle', ghost: true });
  }

  const from = left[0]?.key;
  const links: FlowLink[] = from
    ? right.map((b) => ({
        from,
        to: b.key,
        label: b.ghost ? undefined : i.tech ? 'WAL stream' : 'every change',
        tone: b.ghost ? 'idle' : b.statTone === 'warn' ? 'warn' : 'info',
        dashed: b.ghost,
      }))
    : [];
  return { columns: [left, right], links };
}
