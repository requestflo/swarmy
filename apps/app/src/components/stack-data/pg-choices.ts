/**
 * The managed-Postgres "keep it safe if a server fails" choice, in plain words
 * (RDatabase board). Three honest choices map onto the `swarmy.db.topology`
 * label + the declared replica count:
 *
 *   one      single                         (no standby; restore from the last save)
 *   standby  primary-replica, replicas ≥ 1  (a copy follows every change)
 *   auto     failover, replicas ≥ 1         (the copy is kept on another server)
 *
 * Every promotion goes through the caught-up rule (`decideFailover`): swarmy
 * only switches over by itself when the copy provably has every change,
 * otherwise it holds and asks an owner. The words below never promise more.
 * PURE — no React, tested in pg-choices.test.ts.
 */

export type HaChoice = 'one' | 'standby' | 'auto';
export const HA_CHOICES: readonly HaChoice[] = ['one', 'standby', 'auto'];

export interface PgMember {
  service: string;
  role: 'primary' | 'replica' | 'dcs';
  status: string;
  desired: number;
  running: number;
  lagSeconds?: number;
}

/** The slice of `db.get`'s cluster view this page reads. */
export interface PgClusterFacts {
  name: string;
  topology: 'single' | 'primary-replica' | 'failover' | 'geo' | 'active-active';
  replicas: { desired: number; running: number };
  members: PgMember[];
  pitr: boolean;
  maxLagSeconds?: number;
  rwHost: string;
  roHost: string;
  primary: { service: string; status: string };
}

/** The slice of `dbBackups.overview` this page reads. */
export interface PgBackupFacts {
  cron: string | null;
  retentionDays: number | null;
  lastSizeBytes: string | null;
  lastBackupAt: string | null;
  lastStatus: string | null;
  pitr: boolean;
}

/** The choice the cluster is on today; `null` for geo / active-active (a custom shape). */
export function currentChoice(c: Pick<PgClusterFacts, 'topology' | 'replicas'>): HaChoice | null {
  if (c.topology === 'geo' || c.topology === 'active-active') return null;
  if (c.topology === 'single' || c.replicas.desired === 0) return 'one';
  return c.topology === 'failover' ? 'auto' : 'standby';
}

/** The next step up, when there is one worth recommending. */
export function recommendedChoice(current: HaChoice | null, autoReady: boolean): HaChoice | null {
  if (current === 'one') return 'standby';
  if (current === 'standby' && autoReady) return 'auto';
  return null;
}

const pad = (n: string): string => n.padStart(2, '0');

/** "every night at 03:00" / "every hour" / "on a schedule (…)" / null when unscheduled. */
export function cronWords(cron: string | null): string | null {
  if (!cron) return null;
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return `on a schedule (${cron})`;
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string];
  const plain = dom === '*' && mon === '*';
  if (plain && /^\d+$/.test(m) && /^\d+$/.test(h)) {
    const at = `${pad(h)}:${pad(m)}`;
    if (dow === '*') return `every night at ${at}`;
    if (/^\d$/.test(dow)) {
      const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(dow) % 7];
      return `every ${day} at ${at}`;
    }
  }
  if (plain && dow === '*' && /^\d+$/.test(m) && h === '*') return 'every hour';
  const step = /^\*\/(\d+)$/.exec(h);
  if (plain && dow === '*' && step) return `every ${step[1]} hours`;
  return `on a schedule (${cron})`;
}

export function humanBytes(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

export interface ChoiceFacts {
  title: string;
  say: string;
  down: string;
  lose: string;
  cost: string;
  /** Controls-depth technical line. */
  tech: string;
}

/** The three choices' plain facts + technical line for one cluster. */
export function choiceFacts(choice: HaChoice, c: PgClusterFacts, b: PgBackupFacts | null): ChoiceFacts {
  const pitr = c.pitr || !!b?.pitr;
  const lag = c.maxLagSeconds;
  const lagText = lag !== undefined ? `lag ${lag} s` : 'lag not measured yet';
  const saved = cronWords(b?.cron ?? null);
  if (choice === 'one') {
    return {
      title: 'One copy',
      say: pitr
        ? 'Cheapest. If the server dies, swarmy rebuilds from the last save and replays the changes since.'
        : 'Cheapest. If the server dies, swarmy rebuilds from the last save.',
      down: 'until a restore finishes',
      lose: pitr ? 'a few minutes' : saved ? 'changes since the last save' : 'everything not saved',
      cost: '$0',
      tech: [
        'single primary',
        b?.cron ? `backup cron ${b.cron}` : 'no backup schedule',
        pitr ? `WAL archive PITR${b?.retentionDays ? ` ${b.retentionDays} d` : ''} · RPO ≤ 5 min` : 'no WAL archive · RPO = last backup',
        'RTO = restore time',
      ].join(' · '),
    };
  }
  if (choice === 'standby') {
    return {
      title: 'A standby copy',
      say: 'A second copy follows every change and can take over. swarmy puts it wherever there is room, so it can share the main server.',
      down: 'about a minute',
      lose: 'nothing, or it asks you first',
      cost: '$0 · one more disk',
      tech: `async streaming replica · ${lagText} · promote only when replay_lsn ≥ last flushed lsn, else hold + ask · RTO ~1 min`,
    };
  }
  return {
    title: 'Switch over by itself',
    say: 'The same standby copy, kept on a different server so one failure can’t take both. swarmy switches over on its own, only when it can prove nothing is lost.',
    down: 'about 30 s',
    lose: 'nothing, or it waits',
    cost: '$0 · one more disk',
    tech: `replica on another server (avoidNode) · ${lagText} · auto-promote iff replay_lsn ≥ flushed_lsn · else hold + page · RTO ~30 s`,
  };
}

/** What happens if the main server stopped right now, as numbered plain steps. */
export function ifStoppedSteps(choice: HaChoice, c: PgClusterFacts, b: PgBackupFacts | null): { lead: string; rest: string }[] {
  const pitr = c.pitr || !!b?.pitr;
  if (choice === 'one') {
    return [
      { lead: 'The app stops saving changes', rest: 'and swarmy tells you in Activity.' },
      { lead: 'You restore the last save', rest: pitr ? 'onto another server; swarmy replays the changes since.' : 'onto another server.' },
      { lead: pitr ? 'A few minutes of changes' : 'Changes since the last save', rest: 'could be lost.' },
    ];
  }
  const lag = c.maxLagSeconds;
  return [
    {
      lead: 'swarmy checks the standby copy has every change.',
      rest: lag !== undefined ? `It is ${lag} s behind right now.` : 'It measures how far behind the copy is.',
    },
    {
      lead: 'If it is fully caught up, it takes over by itself',
      rest: `in about ${choice === 'auto' ? '30 seconds' : 'a minute'}. If not, it waits and asks an owner, showing exactly what could be lost.`,
    },
    { lead: 'Nothing is lost silently.', rest: 'The old main server rejoins as the standby when it comes back.' },
  ];
}

export interface ApplyStep {
  kind: 'topology' | 'replicas';
  topology?: 'single' | 'primary-replica' | 'failover';
  replicas?: number;
}

/** The mutations that move a cluster to `choice` (replicas before failover, which needs one). */
export function applySteps(choice: HaChoice, c: Pick<PgClusterFacts, 'replicas'>): ApplyStep[] {
  const want = Math.max(1, c.replicas.desired);
  if (choice === 'one') return [{ kind: 'topology', topology: 'single' }, { kind: 'replicas', replicas: 0 }];
  const steps: ApplyStep[] = [];
  if (c.replicas.desired !== want) steps.push({ kind: 'replicas', replicas: want });
  steps.push({ kind: 'topology', topology: choice === 'auto' ? 'failover' : 'primary-replica' });
  return steps;
}

/** The label a choice renders on the cluster's primary (Code depth). */
export function choiceLabels(choice: HaChoice, c: Pick<PgClusterFacts, 'replicas'>): Record<string, string> {
  const topology = choice === 'one' ? 'single' : choice === 'auto' ? 'failover' : 'primary-replica';
  const replicas = choice === 'one' ? 0 : Math.max(1, c.replicas.desired);
  return { 'swarmy.db.topology': topology, 'swarmy.db.replicas': String(replicas) };
}
