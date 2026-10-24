/**
 * How a Heroku app's data and config come across. swarmy doesn't move them
 * itself; this says exactly how, for one {@link fromHeroku} conversion. Pure.
 *
 * Data goes through swarmy's own restore path. A Heroku backup is a
 * `pg_dump -Fc` file, the same artefact swarmy's `pg_dump` backups store at
 * `/backup/dump.pgc`. Stored in the backup destination tagged as
 * `<stack>/<db>`'s pg_dump backup, it shows up on the app's Backups tab, and
 * Restore in place (`dbBackup.restore`) saves the current data first, then
 * loads it with `pg_restore --clean --if-exists --no-owner`.
 *
 * Config goes through Paste .env: `heroku config --shell`, minus the add-on
 * URLs swarmy's bindings fill in.
 */
import type { HerokuConversion } from './from-heroku';

/** The restic image swarmy's agents run (`DEFAULT_RESTIC_IMAGE`; a test keeps them equal). */
export const HEROKU_IMPORT_RESTIC_IMAGE = 'restic/restic:0.16.4';
/** The `reason:` tag the stored dump carries — the restore point's label on the Backups tab. */
export const HEROKU_IMPORT_REASON = 'heroku-import';

export interface MigrationStep {
  /** Plain words: what this step does. */
  title: string;
  /** A terminal on your machine, or the swarmy dashboard. */
  where: 'terminal' | 'dashboard';
  /** The exact commands (terminal) or the dashboard path (dashboard). */
  lines: string[];
  /** What to know: why it's safe, what it needs. */
  note?: string;
}

export interface HerokuMigration {
  /** Per database: back up on Heroku → store as a swarmy pg_dump backup → restore in place. */
  data: MigrationStep[];
  /** `heroku config` → Paste .env. */
  config: MigrationStep[];
}

const shq = (s: string): string => (/^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function herokuMigrationSteps(
  conv: Pick<HerokuConversion, 'app' | 'databases' | 'secrets' | 'bound'>,
  opts: { herokuApp?: string } = {},
): HerokuMigration {
  const herokuApp = `export HEROKU_APP=${shq(opts.herokuApp ?? conv.app)}   # the app's name on Heroku`;
  const data: MigrationStep[] = [];
  conv.databases.forEach((db, i) => {
    const attachment = db.envVar.replace(/_URL$/, '');
    data.push(
      {
        title: `Back up ${attachment} on Heroku and download it`,
        where: 'terminal',
        lines: [
          ...(i === 0 ? [herokuApp] : []),
          `heroku pg:backups:capture ${attachment} --app "$HEROKU_APP"`,
          'mkdir -p backup',
          `heroku pg:backups:download --app "$HEROKU_APP" --output backup/dump.pgc`,
        ],
        note: `Heroku keeps running and nothing there changes. ${db.resource} runs Postgres ${db.version}: pg_restore loads a dump from the same or an older Postgres, never a newer one.`,
      },
      {
        title: `Add it to ${db.resource}'s backups`,
        where: 'terminal',
        lines: [
          `# the destination ${db.resource} backs up to (Data › Backups): its repository, password and keys`,
          'export RESTIC_REPOSITORY=s3:<endpoint>/<bucket>/<prefix> RESTIC_PASSWORD=<password> AWS_ACCESS_KEY_ID=<key-id> AWS_SECRET_ACCESS_KEY=<secret>',
          'docker run --rm -v "$PWD/backup:/backup:ro" -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \\',
          `  ${HEROKU_IMPORT_RESTIC_IMAGE} backup /backup --tag db:${conv.app}/${db.resource} --tag engine:pg_dump --tag reason:${HEROKU_IMPORT_REASON}`,
        ],
        note: `Heroku's file is a pg_dump -Fc dump, the same kind swarmy's own backups of ${db.resource} store, so it lands where theirs do and the Backups tab lists it.`,
      },
      {
        title: `Restore it into ${db.resource}`,
        where: 'dashboard',
        lines: [`${conv.app} › Backups → ${db.resource} → the ${HEROKU_IMPORT_REASON} copy → Restore in place`],
        note: `swarmy saves ${db.resource}'s current data first, then loads the dump with pg_restore --clean --if-exists --no-owner. Anything written on Heroku after the backup stays there, so take it just before you switch over.`,
      },
    );
  });

  const drop = conv.bound.length ? ` | grep -v -E '^(${conv.bound.join('|')})='` : '';
  const secrets = conv.secrets.map((s) => s.name);
  const config: MigrationStep[] = [
    {
      title: 'Export the config vars',
      where: 'terminal',
      lines: [...(data.length ? [] : [herokuApp]), `heroku config --shell --app "$HEROKU_APP"${drop} > heroku.env`],
      note: `${conv.bound.length ? `${conv.bound.join(', ')} stay behind: swarmy fills in its own. ` : ''}heroku.env holds secret values, so keep it out of git and delete it when you're done.`,
    },
    {
      title: 'Paste it into web',
      where: 'dashboard',
      lines: [`${conv.app} › Config › Variables & secrets › Paste .env → web`],
      note: secrets.length
        ? `Paste .env keeps secret-looking values secret and shows every change before it deploys. swarmy.yaml reads ${secrets.length === 1 ? 'one of them as a swarmy secret' : `${secrets.length} of them as swarmy secrets`} (${secrets.join(', ')}): add ${secrets.length === 1 ? 'it' : 'each'} on Variables & secrets as a secret with that name.`
        : 'Paste .env keeps secret-looking values secret and shows every change before it deploys.',
    },
  ];
  return { data, config };
}
