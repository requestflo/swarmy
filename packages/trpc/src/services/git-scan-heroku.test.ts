import { describe, expect, it } from 'bun:test';
import { detectBuild } from './git-providers/detect-build';
import type { InspectResult } from './git-providers/inspect';
import { scanFromInspect, scanReadPaths } from './git-scan';

const APP_JSON = JSON.stringify(
  {
    name: 'Shop Classic',
    formation: { web: { quantity: 2, size: 'standard-2x' } },
    addons: ['heroku-postgresql:standard-0', 'heroku-redis:mini', 'papertrail'],
    buildpacks: [{ url: 'heroku/ruby' }],
    env: { SECRET_KEY_BASE: { generator: 'secret' } },
  },
  null,
  2,
);

/** A Heroku repo at the root: the Procfile and Gemfile as 4 KB probes, app.json read whole. */
const READ: InspectResult = {
  sha: 'a'.repeat(40),
  files: { 'swarmy.yaml': null, 'app.json': APP_JSON },
  tree: ['Gemfile'],
  probes: {
    Procfile: 'web: bundle exec puma -C config/puma.rb\nworker: bundle exec sidekiq\nrelease: bundle exec rails db:migrate\n',
    'app.json': APP_JSON.slice(0, 40),
    Gemfile: "source 'https://rubygems.org'\ngem 'rails'\ngem 'pg'\ngem 'sidekiq'\n",
  },
};

describe('scanFromInspect: "Looks like a Heroku app"', () => {
  const detected = detectBuild(READ.probes!, '');
  const v = scanFromInspect(READ, { dir: '', repo: 'https://github.com/northwind/shop-classic.git', detected, ms: 900 });
  const h = v.heroku!;

  it('reads app.json whole, so the import parses past the 4 KB probe', () => {
    expect(scanReadPaths('apps/shop')).toEqual(['apps/shop/app.json']);
    expect(h.label).toBe('Looks like a Heroku app');
    expect(h.why).toBe("swarmy.yaml comes from app.json and the Procfile: 2 process types and 1 database. 1 thing didn't come across — each says what to do.");
    expect(h.evidence.map((e) => `${e.file}:${e.line}`)).toEqual(['Procfile:1', 'Procfile:2', 'Procfile:3', 'app.json:9']);
  });

  it("the draft is the importer's swarmy.yaml, checked by the parser and drawn like any other", () => {
    expect(h.draft.valid).toBe(true);
    expect(h.draft.yaml.startsWith('# Imported from Heroku')).toBe(true);
    expect(h.draft.graph).toEqual({
      stack: 'shop-classic',
      services: [
        { name: 'web', meta: 'build · :5000 · 2 copies', wires: ['cache', 'db'] },
        { name: 'worker', meta: 'build · no address · 1 copy', wires: ['cache', 'db'] },
      ],
      data: [
        { name: 'cache', meta: 'valkey · 256 MB' },
        { name: 'db', meta: 'postgres 16 · backed up daily' },
      ],
      jobs: [],
    });
  });

  it('carries what did not come across and the data + config steps', () => {
    expect(h.untranslated.filter((g) => !g.handled).map((g) => g.key)).toEqual(['env.SECRET_KEY_BASE']);
    expect(h.untranslated.find((g) => g.key === 'addons: papertrail')).toMatchObject({ handled: true });
    expect(h.steps.data.map((s) => s.title)).toEqual(['Back up DATABASE on Heroku and download it', "Add it to db's backups", 'Restore it into db']);
    expect(h.steps.config[0]!.lines.at(-1)).toBe(`heroku config --shell --app "$HEROKU_APP" | grep -v -E '^(DATABASE_URL|REDIS_URL|REDIS_TLS_URL)=' > heroku.env`);
    // The generic detections stay, for when the Heroku import is unticked.
    expect(v.detections.map((d) => d.id)).toEqual(['web', 'worker:worker', 'postgres', 'queue']);
  });

  it('a folder without a Procfile has no Heroku view', () => {
    const plain = scanFromInspect({ ...READ, probes: { Gemfile: READ.probes!.Gemfile! } }, { dir: '', repo: 'x', detected, ms: 1 });
    expect(plain.heroku).toBeUndefined();
  });
});
