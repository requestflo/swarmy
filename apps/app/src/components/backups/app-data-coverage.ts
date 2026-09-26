import type { DbBackupOverviewRow } from '@swarmy/core';
import type { AlreadyOnItem } from '@/components/calm';
import { scheduleWords } from '@/components/data/estate-data';

/** The slice of `backups.autoCoverage` these words read. */
interface Coverage {
  appOptedOut?: boolean;
  destination: { name: string } | null;
  databases: { name: string; status: string }[];
  volumes?: { volume: string; status: string }[];
}

const on = (s: string): boolean => s === 'auto' || s === 'user';

/**
 * What one app keeps and whether it's saved, from the two places that know:
 * default-on coverage (its compose databases and volumes) and its managed
 * databases' own schedules (`dbBackups.overview`, what the Data tab shows).
 * The app's Overview facts and its Backups tab both read this, so they agree.
 */
export function appDataCoverage(stack: string, c: Coverage | undefined, managed: DbBackupOverviewRow[] | undefined) {
  const mine = (managed ?? []).filter((r) => r.stack === stack);
  const dbs = (c?.databases ?? []).length + mine.length;
  const vols = c?.volumes ?? [];
  const savedDbs = (c?.databases ?? []).filter((d) => on(d.status)).length + mine.filter((r) => r.scheduled).length;
  const failing = mine.filter((r) => r.scheduled && r.lastStatus === 'failed');
  const savedVols = vols.filter((v) => on(v.status)).length;
  return { mine, dbs, vols, savedDbs, savedVols, failing, keepsNothing: dbs === 0 && vols.length === 0 };
}

export type AppDataCoverage = ReturnType<typeof appDataCoverage>;

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The app facts' "Data" line: "1 database, saved nightly at 03:00" / "Keeps no data of its own". */
export function dataFactWords(a: AppDataCoverage): string {
  if (a.keepsNothing) return 'Keeps no data of its own';
  const what = a.dbs ? plural(a.dbs, 'database') : plural(a.vols.length, 'volume');
  const saved = a.dbs ? a.savedDbs : a.savedVols;
  if (saved === 0) return `${what}, not backed up yet`;
  if (a.failing.length) return `${what}, the last save failed`;
  const cron = a.mine.find((r) => r.scheduled)?.cron ?? null;
  return `${what}, saved ${cron ? scheduleWords(cron) : 'nightly'}`;
}

/** The Backups tab's "Already on": only what is fully on, never a partial state. */
export function backupsAlreadyOn(a: AppDataCoverage, c: Coverage | undefined): AlreadyOnItem[] {
  const out: AlreadyOnItem[] = [];
  if (a.vols.length && !c?.appOptedOut && a.savedVols === a.vols.length) {
    out.push({ what: 'Volumes', detail: `all ${a.vols.length} saved nightly` });
  }
  if (a.dbs && a.savedDbs === a.dbs && a.failing.length === 0) {
    const names = a.mine.filter((r) => r.scheduled).map((r) => `${r.cluster} ${scheduleWords(r.cron)}`);
    out.push({ what: 'Databases', detail: names.length ? `${names.join(', ')}` : `all ${a.dbs} saved nightly` });
  }
  out.push({ what: 'Encrypted', detail: 'before it leaves the server' });
  return out;
}
