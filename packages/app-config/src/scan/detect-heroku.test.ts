import { describe, expect, it } from 'bun:test';
import { fromHeroku } from '../from-heroku';
import { parseAppConfig } from '../parse';
import { detectHeroku } from './detect-heroku';
import { scanFile } from './files';

const APP_JSON = '{\n  "name": "Shop",\n  "addons": [\n    "heroku-postgresql:essential-0"\n  ],\n  "buildpacks": [{ "url": "heroku/nodejs" }]\n}\n';
const PROCFILE = '# processes\nweb: node server.js\nworker: node worker.js\nrelease: npm run migrate\n';

describe('detectHeroku', () => {
  it('a Procfile beside a Heroku app.json: the processes and the add-on line as evidence', () => {
    const found = detectHeroku([scanFile('apps/shop/app.json', APP_JSON), scanFile('apps/shop/Procfile', PROCFILE)], 'apps/shop');
    expect(found?.processes).toEqual(['web', 'worker', 'release']);
    expect(found?.evidence).toEqual([
      { file: 'apps/shop/Procfile', line: 2, text: 'web: node server.js' },
      { file: 'apps/shop/Procfile', line: 3, text: 'worker: node worker.js' },
      { file: 'apps/shop/Procfile', line: 4, text: 'release: npm run migrate' },
      { file: 'apps/shop/app.json', line: 3, text: '"addons": [' },
    ]);
    // The texts round-trip into the importer, whose file is the draft.
    const r = fromHeroku({ appJson: found!.appJson, procfile: found!.procfile, app: 'shop', dir: 'apps/shop' });
    expect(parseAppConfig(r.yaml!).config?.services.web).toMatchObject({ build: { type: 'railpack', path: 'apps/shop' }, release: 'npm run migrate' });
  });

  it('needs both files, and an app.json that is Heroku’s (not Expo’s)', () => {
    expect(detectHeroku([scanFile('Procfile', PROCFILE)])).toBeNull();
    expect(detectHeroku([scanFile('app.json', APP_JSON)])).toBeNull();
    expect(detectHeroku([scanFile('app.json', '{ "expo": { "name": "x" } }'), scanFile('Procfile', PROCFILE)])).toBeNull();
    expect(detectHeroku([scanFile('app.json', APP_JSON), scanFile('Procfile', '# nothing yet\n')])).toBeNull();
  });
});
