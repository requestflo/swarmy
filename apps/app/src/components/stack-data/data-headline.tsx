import * as React from 'react';
import { Say } from '@/components/calm';
import type { DataTabData } from './use-data-tab';

const count = (n: number, one: string, many: string): string => `${n === 1 ? 'a' : n} ${n === 1 ? one : many}`;

/** The clause that matters most, or null when every data service is calm. */
function trouble(d: DataTabData): { tone: 'warn' | 'bad'; text: string } | null {
  for (const c of d.clusters) {
    if (c.pendingFailover) return { tone: 'bad', text: `${c.name}’s main copy is down and swarmy is waiting for you.` };
  }
  for (const c of d.clusters) {
    if (c.primary.status !== 'running') return { tone: 'bad', text: `${c.name} is ${c.primary.status}.` };
    if (d.backups[c.name]?.lastStatus === 'failed') return { tone: 'warn', text: `${c.name}’s last save failed.` };
    if (c.replicas.running < c.replicas.desired) return { tone: 'warn', text: `A standby copy of ${c.name} isn’t running.` };
    if ((c.maxLagSeconds ?? 0) >= 5) return { tone: 'warn', text: `${c.name}’s standby copy is ${c.maxLagSeconds} s behind.` };
  }
  for (const c of d.caches) if (c.primary.status !== 'running') return { tone: 'warn', text: `The ${c.name} cache is ${c.primary.status}.` };
  for (const s of d.search) if (s.status !== 'running') return { tone: 'warn', text: `The ${s.name} search is ${s.status}.` };
  return null;
}

/** "storefront keeps its data in 4 places. A standby copy of checkout isn't running." */
export function dataHeadline(stack: string, d: DataTabData): { title: React.ReactNode; lede: React.ReactNode } {
  const n = d.clusters.length + d.caches.length + d.search.length + d.vectors.length;
  if (n === 0) {
    return {
      title: `${stack} doesn’t keep any managed data yet.`,
      lede: 'Add a Postgres database and swarmy provisions it, wires DATABASE_URL into the app and saves it every night.',
    };
  }
  const t = trouble(d);
  const parts = [
    d.clusters.length ? count(d.clusters.length, 'database', 'databases') : null,
    d.caches.length ? count(d.caches.length, 'cache', 'caches') : null,
    d.search.length ? count(d.search.length, 'search index', 'search indexes') : null,
    d.vectors.length ? count(d.vectors.length, 'vector store', 'vector stores') : null,
  ].filter((p): p is string => p !== null);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
  return {
    title: (
      <>
        {stack} keeps its data in {n} {n === 1 ? 'place' : 'places'}.{' '}
        {t ? <Say tone={t.tone}>{t.text}</Say> : <em>All of it is private and saved.</em>}
      </>
    ),
    lede: `${list[0]?.toUpperCase()}${list.slice(1)}, each on the app’s private network with no way in from outside. swarmy saves them and puts the passwords in Docker secrets.`,
  };
}
