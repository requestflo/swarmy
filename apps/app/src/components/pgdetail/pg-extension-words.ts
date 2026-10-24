import type { inferOutput } from '@trpc/tanstack-react-query';
import type { useTRPC } from '@/integrations/trpc';

export type PgExtensionsView = inferOutput<ReturnType<typeof useTRPC>['db']['extensions']>;
export type PgExtensionView = PgExtensionsView['extensions'][number];

export interface PgExtWords {
  /** The row's sentence (Summary words: copies, main copy, standby copy). */
  sentence: string;
  /** The mono line at Controls. */
  tech: string;
  /** The switch can move now. */
  canToggle: boolean;
  busy: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a restart of every copy means for THIS database, in one clause. */
export function restartClause(v: PgExtensionsView): string {
  const standbys = v.copies - 1;
  return standbys > 0
    ? `restarts each copy: the ${plural(standbys, 'standby copy', 'standby copies')} first, then the main copy in place (a few seconds without writes)`
    : 'restarts the database once, in place (a few seconds offline)';
}

function progressSentence(v: PgExtensionsView, turningOn: boolean): string {
  const p = v.progress;
  const verb = turningOn ? 'Turning on' : 'Turning off';
  if (!p) return `${verb}…`;
  if (p.kind === 'blocked') return `Waiting: ${p.reason ?? 'the database is busy'}.`;
  if (p.kind === 'drop') return `${verb}: removing it from the database first.`;
  if (p.kind === 'create') return `${verb}: adding it to the database.`;
  const who = p.phase === 'standby' ? 'the standby copies' : 'the main copy';
  return p.kind === 'restart'
    ? `${verb}: restarting ${who}${p.phase === 'writer' ? ' in place, a few seconds without writes' : ' first'}.`
    : `${verb}: waiting for ${who} to come back.`;
}

/** pg_stat_statements: the restart is the whole story, so it is said up front. */
export function statementsWords(x: PgExtensionView, v: PgExtensionsView): PgExtWords {
  const busy = x.wanted !== x.on || (v.progress !== null && v.progress.kind !== 'blocked' && x.wanted);
  const tech = `swarmy.db.extensions=${x.wanted ? x.name : '∅'} · shared_preload_libraries → rolling restart (replicas, then the primary in place; no promotion) · CREATE EXTENSION ${x.name}`;
  if (v.error && x.wanted && !x.on) return { sentence: `Couldn’t turn it on: ${v.error}`, tech, canToggle: true, busy: false };
  if (busy) {
    const blocked = v.progress?.kind === 'blocked';
    return { sentence: progressSentence(v, x.wanted), tech, canToggle: blocked, busy: !blocked };
  }
  if (x.on) return { sentence: 'On. The studio’s Slow queries shows the last 24 hours. Turning it off ' + restartClause(v) + '.', tech, canToggle: true, busy: false };
  return { sentence: `Records how long every statement takes, for the studio’s Slow queries. Turning it on ${restartClause(v)}.`, tech, canToggle: true, busy: false };
}

/** postgis: only when the image ships it, and enable-only like pgvector. */
export function postgisWords(x: PgExtensionView, v: PgExtensionsView): PgExtWords {
  if (x.on) return { sentence: 'On. Maps and geometry types are ready in this database.', tech: 'there is no off switch: DROP EXTENSION would drop every geometry column', canToggle: false, busy: false };
  if (x.wanted) {
    return v.error
      ? { sentence: `Couldn’t turn it on: ${v.error}`, tech: `CREATE EXTENSION ${x.name}`, canToggle: false, busy: false }
      : { sentence: progressSentence(v, true), tech: `CREATE EXTENSION IF NOT EXISTS ${x.name} · no restart`, canToggle: false, busy: true };
  }
  if (x.available === null) return { sentence: 'Checking whether this database’s image ships PostGIS…', tech: 'pg_available_extensions', canToggle: false, busy: false };
  if (!x.available) {
    return {
      sentence: `Needs a PostGIS image. This database runs ${v.image}, which doesn’t include it.`,
      tech: `pg_available_extensions has no postgis · a postgis image (e.g. postgis/postgis:17-3.5) ships it`,
      canToggle: false,
      busy: false,
    };
  }
  return { sentence: 'Maps and geometry types. Turned on in place; no restart. There is no off switch.', tech: `CREATE EXTENSION IF NOT EXISTS ${x.name}`, canToggle: true, busy: false };
}
