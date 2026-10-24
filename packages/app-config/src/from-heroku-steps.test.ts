import { describe, expect, it } from 'bun:test';
import { DEFAULT_RESTIC_IMAGE } from '@swarmy/core/protocol';
import { fromHeroku } from './from-heroku';
import { HEROKU_IMPORT_RESTIC_IMAGE, herokuMigrationSteps } from './from-heroku-steps';

const conv = fromHeroku({
  app: 'shop',
  procfile: 'web: node server.js',
  appJson: JSON.stringify({ addons: ['heroku-postgresql', 'heroku-redis'] }),
  config: 'STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop\nMODE=live\n',
});

describe('herokuMigrationSteps: data through swarmy restore, config through Paste .env', () => {
  const steps = herokuMigrationSteps(conv, { herokuApp: 'acme-shop' });

  it('backs up on Heroku and downloads the dump where swarmy pg_dump backups keep theirs', () => {
    expect(steps.data.map((s) => [s.where, s.title])).toEqual([
      ['terminal', 'Back up DATABASE on Heroku and download it'],
      ['terminal', "Add it to db's backups"],
      ['dashboard', 'Restore it into db'],
    ]);
    expect(steps.data[0]!.lines).toEqual([
      'export HEROKU_APP=acme-shop   # the app\'s name on Heroku',
      'heroku pg:backups:capture DATABASE --app "$HEROKU_APP"',
      'mkdir -p backup',
      'heroku pg:backups:download --app "$HEROKU_APP" --output backup/dump.pgc',
    ]);
  });

  it("stores it tagged as the cluster's pg_dump backup (the tags dbBackup.list filters on), then restores in place", () => {
    expect(steps.data[1]!.lines.at(-1)).toBe('  restic/restic:0.16.4 backup /backup --tag db:shop/db --tag engine:pg_dump --tag reason:heroku-import');
    expect(steps.data[1]!.lines.at(-2)).toContain('-v "$PWD/backup:/backup:ro"');
    expect(steps.data[2]!.lines).toEqual(['shop › Backups → db → the heroku-import copy → Restore in place']);
    expect(steps.data[2]!.note).toContain('pg_restore --clean --if-exists --no-owner');
  });

  it('runs the restic image the agents run', () => {
    expect(HEROKU_IMPORT_RESTIC_IMAGE).toBe(DEFAULT_RESTIC_IMAGE);
  });

  it('exports heroku config without the add-on URLs, then pastes it, naming the secrets the file reads', () => {
    expect(steps.config[0]!.lines).toEqual([`heroku config --shell --app "$HEROKU_APP" | grep -v -E '^(DATABASE_URL|REDIS_URL|REDIS_TLS_URL)=' > heroku.env`]);
    expect(steps.config[1]).toMatchObject({ where: 'dashboard', lines: ['shop › Config › Variables & secrets › Paste .env → web'] });
    expect(steps.config[1]!.note).toContain('one of them as a swarmy secret (stripe-secret-key)');
  });

  it('with no database there are no data steps, and the config step names the Heroku app', () => {
    const none = herokuMigrationSteps(fromHeroku({ procfile: 'web: node s.js', app: 'tiny' }));
    expect(none.data).toEqual([]);
    expect(none.config[0]!.lines).toEqual(['export HEROKU_APP=tiny   # the app\'s name on Heroku', 'heroku config --shell --app "$HEROKU_APP" > heroku.env']);
  });
});
