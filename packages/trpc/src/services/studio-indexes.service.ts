import { STACK_LABEL } from '@swarmy/core';
import { PG_INDEX_FACTS_SQL, indexAdvice, parseIndexFacts, type IndexTip } from '@swarmy/core/studio';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { DB_CLUSTER_LABEL, DB_ROLE_LABEL } from './manageddb.service';
import { listStudioTargets, studioViewRead } from './studio.service';

/**
 * `studio.indexAdvice` (board 63): index suggestions for one Postgres
 * database. One bounded read of its statistics through the studio path
 * (`studioViewRead`: the person's data.read gate, the row and time limits,
 * one `studio.query` audit row under origin `indexes`), then the pure rules
 * in `@swarmy/core/studio` index-advice.ts. Every tip is SQL to copy: swarmy
 * never creates or drops an index on its own.
 */

export interface StudioIndexAdviceView {
  /** Why there is no advice for this engine, else null. */
  unavailable: string | null;
  database: string | null;
  /** When the counts started (the database's stats reset), null = since they began. */
  statsSince: string | null;
  /** Running standby copies (managed): their own reads aren't in these counts. */
  standbys: number;
  checked: { tables: number; indexes: number; foreignKeys: number };
  tips: IndexTip[];
}

/** Running standby tasks of a managed cluster (labels; no exec). */
export function runningStandbys(ctx: OrgContext, stack: string, cluster: string): number {
  return ctx.hub
    .liveInventory(ctx.activeOrgId)
    .services.filter((s) => s.labels[STACK_LABEL] === stack && s.labels[DB_CLUSTER_LABEL] === cluster && s.labels[DB_ROLE_LABEL] !== 'primary')
    .reduce((n, s) => n + (s.runningReplicas ?? 0), 0);
}

export async function studioIndexAdvice(
  ctx: OrgContext,
  input: { stack: string; target: string; database?: string | null },
): Promise<StudioIndexAdviceView> {
  const t = listStudioTargets(ctx, input.stack).find((x) => x.name === input.target);
  if (!t) throw notFound('database', `${input.stack}/${input.target}`);
  const empty = { database: null, statsSince: null, standbys: 0, checked: { tables: 0, indexes: 0, foreignKeys: 0 }, tips: [] };
  if (t.engine !== 'postgres') {
    return { ...empty, unavailable: 'Index suggestions are for Postgres: they read its table and index statistics.' };
  }
  const r = await studioViewRead(ctx, { stack: input.stack, target: input.target, statement: PG_INDEX_FACTS_SQL, origin: 'indexes', rowCap: 1, database: input.database });
  const facts = parseIndexFacts(r);
  const standbys = t.kind === 'managed' ? runningStandbys(ctx, input.stack, input.target) : 0;
  return {
    unavailable: null,
    database: r.database,
    statsSince: facts.statsReset,
    standbys,
    checked: { tables: facts.tables.length, indexes: facts.indexes.length, foreignKeys: facts.foreignKeys.length },
    tips: indexAdvice(facts, { standbys: standbys > 0 }),
  };
}
