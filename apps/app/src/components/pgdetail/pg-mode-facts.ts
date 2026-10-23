import { formatDurationMs, formatDurationSec } from '@/components/resilience/format';
import { choiceFacts, type HaChoice, type PgBackupFacts, type PgClusterFacts } from '@/components/stack-data/pg-choices';
import type { PgMode } from './pg-topology';

/**
 * What each shape means for one database, under its diagram: what you could
 * lose (RPO) and how long it's down (RTO) if the main server fails, and one
 * plain sentence. The three Data-tab choices reuse `choiceFacts`, so both
 * pages say the same; a single copy uses the restore drill's real time and
 * the last save's real age when there are some. PURE — pg-mode-facts.test.ts.
 */

export interface ModeFacts {
  lose: string;
  down: string;
  say: string;
  /** Controls-depth line. */
  tech: string;
}

export interface ModeContext {
  /** The main copy's server ("wkr-1"), when placement is known. */
  primary: string | null;
  /** The standby copies' servers ("mgr-2" / "mgr-2 and wkr-2"). */
  standbys: string | null;
  /** A standby shares the main copy's server. */
  sameServer: boolean;
  /** The write region (geo) or the main server's region. */
  region: string | null;
  /** The last passed restore drill in this app: its time and which cluster it ran on. */
  drill: { rtoMs: number; target: string | null } | null;
  /** `<stack>/<cluster>`, to tell a drill on this database from one on another. */
  ref: string;
  now: number;
}

const CHOICE: Partial<Record<PgMode, HaChoice>> = { single: 'one', 'primary-replica': 'standby', failover: 'auto' };

function restoreTime(ctx: ModeContext): string | null {
  if (!ctx.drill) return null;
  const t = ctx.drill.target;
  const where = t === ctx.ref ? ', from the last drill' : t ? `, from a drill on ${t}` : ', from a past drill';
  return `about ${formatDurationMs(ctx.drill.rtoMs)} to restore${where}`;
}

export function modeFacts(mode: PgMode, c: PgClusterFacts, b: PgBackupFacts | null, ctx: ModeContext): ModeFacts {
  const main = ctx.primary ?? 'the main server';
  const choice = CHOICE[mode];
  if (choice) {
    const f = choiceFacts(choice, c, b);
    if (choice === 'one') {
      const age = b?.lastBackupAt ? Math.max(0, Math.round((ctx.now - Date.parse(b.lastBackupAt)) / 1000)) : null;
      const pitr = c.pitr || !!b?.pitr;
      return {
        lose: !pitr && age !== null ? `up to ${formatDurationSec(age)} of changes, the last save’s age` : f.lose,
        down: restoreTime(ctx) ?? `${f.down} · a drill would time it`,
        say: `No standby copy. If ${main} stops, you put back the last save on another server.`,
        tech: f.tech,
      };
    }
    const where = ctx.standbys ? ` on ${ctx.standbys}` : '';
    const say =
      choice === 'standby'
        ? `A standby copy${where} follows every change. swarmy switches over by itself only when it has every change.${ctx.sameServer ? ` It shares ${main} with the main copy, so losing that server loses both.` : ''}`
        : `The standby copy is kept off ${main}, so one failure can’t take both. swarmy switches over only when it can prove nothing is lost.`;
    return { lose: f.lose, down: f.down, say, tech: f.tech };
  }
  if (mode === 'geo') {
    return {
      lose: 'nothing, or it asks you first',
      down: 'about 30 s, when a copy is caught up',
      say: `Writes go to ${ctx.region ?? 'the write region'}. Copies in other regions serve nearby reads from DATABASE_RO_URL; switching over across regions asks you unless the copy is caught up.`,
      tech: 'swarmy.db.writeRegion + swarmy.db.region.<r>.replicas · cross-region replicas trail more, so the caught-up gate holds more often',
    };
  }
  return {
    lose: 'what a writer hadn’t sent to the others',
    down: 'nothing to switch: the other writers keep going',
    say: 'Every region writes and nothing is ever switched over. Your app must tolerate write conflicts.',
    tech: 'active-active never promotes (failoverPolicy = never)',
  };
}
