import * as React from 'react';
import type { NodeSummary } from '@swarmy/core';
import { Say } from '@/components/calm';
import { pgSentence } from '@/components/stack-data/pg-ha-section';
import { serverList } from '@/components/stack-data/use-member-servers';
import { shortName } from './pg-topology';
import type { PgDetailData } from './use-pg-detail';

const unique = (ns: NodeSummary[]): NodeSummary[] => ns.filter((n, i) => ns.findIndex((x) => x.id === n.id) === i);

/** "checkout keeps a standby copy on mgr-2. 1 of 2 standby copies isn't running." + the lede. */
export function pgDetailHeadline(d: PgDetailData): { title: React.ReactNode; lede: React.ReactNode } {
  const c = d.cluster!;
  const on = (role: 'primary' | 'replica'): NodeSummary[] =>
    unique(c.members.filter((m) => m.role === role).flatMap((m) => d.place?.get(m.service) ?? []));
  const main = on('primary')[0];
  const standbys = serverList(on('replica'));
  const missing = c.replicas.desired - c.replicas.running;
  const lag = c.maxLagSeconds;

  let base: string;
  if (c.topology === 'single' || c.replicas.desired === 0) base = `${c.name} runs as one copy${main ? ` on ${main.name}` : ''}.`;
  else if (c.topology === 'active-active') base = `${c.name} takes writes in ${c.primaries ?? 2} places.`;
  else if (c.topology === 'geo') base = `${c.name} writes in ${c.writeRegion ?? main?.region ?? 'one region'} and keeps copies near your users.`;
  else base = `${c.name} keeps a standby copy${standbys ? ` on ${standbys}` : ''}.`;

  const clause = c.pendingFailover ? (
    <Say tone="bad">Its main copy is down, and swarmy is holding the switch-over for you.</Say>
  ) : c.primary.status !== 'running' ? (
    <Say tone="bad">Its main copy is {c.primary.status}.</Say>
  ) : missing > 0 ? (
    <Say tone="warn">
      {missing} of {c.replicas.desired} standby copies {missing === 1 ? 'isn’t' : 'aren’t'} running.
    </Say>
  ) : lag !== undefined && lag >= 5 ? (
    <Say tone="warn">The standby copy is {Math.round(lag)} s behind.</Say>
  ) : c.replicas.desired > 0 ? (
    <em>Every change is copied.</em>
  ) : (
    <em>There is no standby copy.</em>
  );

  const apps = (d.attached ?? []).map(shortName);
  const saved = pgSentence(c, d.backup).text;
  return {
    title: (
      <>
        {base} {clause}
      </>
    ),
    lede: `Postgres${main ? ` on ${main.name}${main.region ? ` in ${main.region}` : ''}` : ''}. ${saved} ${apps.length ? `DATABASE_URL goes to ${apps.join(', ')}.` : 'No app is wired to it yet.'}`,
  };
}
