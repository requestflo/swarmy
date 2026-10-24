import { describe, expect, it } from 'bun:test';
import { buildpackId } from './from-heroku-build';
import { claimName, cronSchedule, dynoSize, readAppJson, readHerokuConfig, readProcfile } from './from-heroku-read';

describe('readHerokuConfig: every shape `heroku config` prints', () => {
  const want = { DATABASE_URL: 'postgres://u:p@h:5432/d', GREETING: 'hello world', EMPTY: '' };

  it('the default table', () => {
    expect(readHerokuConfig('=== shop Config Vars\nDATABASE_URL: postgres://u:p@h:5432/d\nGREETING:     hello world\nEMPTY:\n')).toEqual(want);
  });

  it('--shell (quoted, and the older unquoted form)', () => {
    expect(readHerokuConfig("DATABASE_URL='postgres://u:p@h:5432/d'\nGREETING='hello world'\nEMPTY=''\n")).toEqual(want);
    expect(readHerokuConfig('DATABASE_URL=postgres://u:p@h:5432/d\nGREETING="hello world"\nEMPTY=\n')).toEqual(want);
  });

  it('--json, and nothing for junk', () => {
    expect(readHerokuConfig(JSON.stringify(want))).toEqual(want);
    expect(readHerokuConfig('{ broken')).toEqual({});
    expect(readHerokuConfig('')).toEqual({});
  });
});

describe('readAppJson', () => {
  it('reads env specs, formation, add-on plans and attachments, buildpacks, scripts, cron and environments', () => {
    const r = readAppJson(
      JSON.stringify({
        name: 'Shop',
        env: { A: 'plain', B: { value: 1 }, C: { generator: 'secret' }, D: { description: 'Stripe', required: true } },
        formation: { web: { quantity: 2, size: 'Standard-2X' } },
        addons: ['heroku-postgresql:Essential-0', { plan: 'heroku-redis', as: 'cache' }, { nope: 1 }],
        buildpacks: [{ url: 'heroku/nodejs' }, 'heroku/python'],
        scripts: { postdeploy: 'npm run seed', blank: '' },
        cron: [{ command: 'node job.js', schedule: '*/5 * * * *' }, { command: 'x' }],
        environments: { review: {}, test: {} },
      }),
    );
    expect('json' in r && r.json).toEqual({
      name: 'Shop',
      env: {
        A: { value: 'plain', required: false, generated: false },
        B: { value: '1', required: false, generated: false },
        C: { required: false, generated: true },
        D: { description: 'Stripe', required: true, generated: false },
      },
      formation: { web: { quantity: 2, size: 'standard-2x' } },
      addons: [
        { service: 'heroku-postgresql', plan: 'essential-0', options: {}, raw: 'heroku-postgresql:Essential-0' },
        { service: 'heroku-redis', as: 'CACHE', options: {}, raw: 'heroku-redis' },
      ],
      buildpacks: ['heroku/nodejs', 'heroku/python'],
      scripts: { postdeploy: 'npm run seed' },
      cron: [{ command: 'node job.js', schedule: '*/5 * * * *' }],
      environments: ['review', 'test'],
    });
  });
});

describe('small readers', () => {
  it('Procfile lines, skipping comments and junk', () => {
    expect(readProcfile('# processes\nweb: node s.js\n\nnot a line\nworker:   node w.js --queue a:b\n')).toEqual([
      { name: 'web', command: 'node s.js' },
      { name: 'worker', command: 'node w.js --queue a:b' },
    ]);
  });

  it('dyno sizes: a preset where one fits, else memory', () => {
    expect(dynoSize('eco')).toEqual({ size: 'small' });
    expect(dynoSize('standard-2x')).toEqual({ size: 'medium' });
    expect(dynoSize('performance-m')).toEqual({ memory: '2560mb' });
    expect(dynoSize('performance-l')).toEqual({ memory: '14gb' });
    expect(dynoSize('quantum-9x')).toBeNull();
  });

  it('cron shorthands, unit names and buildpack ids', () => {
    expect(cronSchedule('@hourly')).toBe('0 * * * *');
    expect(cronSchedule('*/10 * * * *')).toBe('*/10 * * * *');
    expect(cronSchedule('every 10 minutes')).toBeNull();
    const taken = new Set(['web']);
    expect([claimName('Urgent_Worker', taken, 'w'), claimName('urgent-worker', taken, 'w'), claimName('9', taken, 'worker')]).toEqual(['urgent-worker', 'urgent-worker-2', 'worker']);
    expect(['heroku/nodejs', 'https://github.com/heroku/heroku-buildpack-ruby.git', 'heroku-community/apt'].map(buildpackId)).toEqual(['nodejs', 'ruby', 'apt']);
  });
});
