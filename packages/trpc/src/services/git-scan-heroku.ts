/**
 * "Looks like a Heroku app" on board 24 — PURE. A folder with a Procfile
 * beside a Heroku app.json gets the importer's swarmy.yaml as its draft
 * (`fromHeroku`, checked by the controller's parser), what didn't come
 * across with why, and the exact steps for the data (a Heroku backup
 * restored through `dbBackup.restore`) and the config vars (`heroku config`
 * into Paste .env). Nothing is imported: data stays on Heroku until you move it.
 */
import {
  detectHeroku,
  fromHeroku,
  herokuMigrationSteps,
  type Evidence,
  type HerokuGap,
  type HerokuMigration,
  type ScanFile,
} from '@swarmy/app-config';
import { toDraftView, type DraftView } from './git-scan-draft';

export interface HerokuScanView {
  /** The found-list row: "Looks like a Heroku app". */
  label: string;
  /** Plain words: what it read and what's left to do. */
  why: string;
  /** The Procfile's processes and the app.json line that gave it away. */
  evidence: Evidence[];
  /** The imported swarmy.yaml, checked and drawn like any draft. */
  draft: DraftView;
  /** What changed shape on the way (a dyno size became memory:, a URL a binding). */
  changes: string[];
  /** What didn't come across, each with why. */
  untranslated: HerokuGap[];
  /** Data (pg:backups → swarmy restore) and config (heroku config → Paste .env). */
  steps: HerokuMigration;
}

const count = (k: number, one: string): string => `${k} ${one}${k === 1 ? '' : 's'}`;

export function herokuScanView(files: ScanFile[], dir: string, app: string): HerokuScanView | null {
  const found = detectHeroku(files, dir);
  if (!found) return null;
  const conv = fromHeroku({ appJson: found.appJson, procfile: found.procfile, app, dir });
  if (!conv.yaml) return null;
  const procs = found.processes.filter((p) => p !== 'release').length;
  const todo = conv.untranslated.filter((g) => !g.handled).length;
  const dbs = conv.databases.length;
  const why =
    `swarmy.yaml comes from app.json and the Procfile: ${count(procs, 'process type')}${dbs ? ` and ${count(dbs, 'database')}` : ''}. ` +
    (todo ? `${count(todo, 'thing')} didn't come across — each says what to do.` : 'Everything came across.');
  return {
    label: 'Looks like a Heroku app',
    why,
    evidence: found.evidence,
    draft: toDraftView(conv.yaml, []),
    changes: conv.changes,
    untranslated: conv.untranslated,
    steps: herokuMigrationSteps(conv),
  };
}
