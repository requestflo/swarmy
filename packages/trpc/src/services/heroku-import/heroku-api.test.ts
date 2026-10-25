import { describe, expect, it } from 'bun:test';
import { readHerokuApp, readHerokuConfigVars } from './heroku-api';

const TOKEN = 'hrku-0123456789abcdef';

/** A fake api.heroku.com: path → JSON body (or a status), recording every request. */
function fakeHeroku(routes: Record<string, unknown>, status: Record<string, number> = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }): Promise<Response> => {
    calls.push({ url, headers: init.headers });
    const path = url.replace('https://api.heroku.com', '');
    if (status[path]) return new Response('{"id":"nope"}', { status: status[path] });
    if (!(path in routes)) return new Response('{"id":"not_found"}', { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200 });
  };
  return { calls, fetchImpl };
}

const APP = {
  '/apps/acme-shop': { name: 'acme-shop', stack: { name: 'heroku-24' }, region: { name: 'us' } },
  '/apps/acme-shop/formation': [{ type: 'web', quantity: 2, size: 'Standard-2X', command: 'npm start' }],
  '/apps/acme-shop/releases': [{ version: 41, current: false, slug: { id: 'old' } }, { version: 42, current: true, slug: { id: 'slug-42' } }],
  '/apps/acme-shop/slugs/slug-42': { process_types: { web: 'npm start', release: 'npm run migrate' } },
  '/apps/acme-shop/addons': [],
  '/apps/acme-shop/buildpack-installations': [{ buildpack: { url: 'heroku/nodejs' } }],
  '/apps/acme-shop/config-vars': { NODE_ENV: 'production', EMPTY: null },
  '/apps/acme-shop/domains': [],
};

describe('the Heroku Platform API client', () => {
  it('reads the app with GETs only, v3 + bearer token, and the current release’s Procfile', async () => {
    const h = fakeHeroku(APP);
    const snap = await readHerokuApp(TOKEN, 'acme-shop', h.fetchImpl);
    expect(snap.processTypes).toEqual({ web: 'npm start', release: 'npm run migrate' });
    expect(snap.app).toEqual({ name: 'acme-shop', stack: { name: 'heroku-24' } });
    expect(snap.formation[0]).toMatchObject({ type: 'web', quantity: 2 });
    expect(h.calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}` && c.headers.Accept === 'application/vnd.heroku+json; version=3')).toBe(true);
    expect(h.calls.find((c) => c.url.endsWith('/releases'))!.headers.Range).toBe('version ..; order=desc, max=20');
    expect(h.calls).toHaveLength(8);
  });

  it('a release with no slug leaves the Procfile unknown', async () => {
    const h = fakeHeroku({ ...APP, '/apps/acme-shop/releases': [{ version: 1, current: true, slug: null }] });
    expect((await readHerokuApp(TOKEN, 'acme-shop', h.fetchImpl)).processTypes).toBeNull();
  });

  it('says what went wrong in plain words — and never echoes the token', async () => {
    const cases: Array<[number, RegExp]> = [[401, /didn’t accept that token/], [403, /can’t read this app/], [429, /rate-limiting/]];
    for (const [code, said] of cases) {
      const h = fakeHeroku(APP, { '/apps/acme-shop': code });
      const err = await readHerokuApp(TOKEN, 'acme-shop', h.fetchImpl).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(said);
      expect((err as Error).message).not.toContain(TOKEN);
    }
    const missing = await readHerokuApp(TOKEN, 'nope', fakeHeroku(APP).fetchImpl).catch((e: Error) => e.message);
    expect(missing).toBe('Heroku has no app by that name for this token.');
    const down = await readHerokuApp(TOKEN, 'acme-shop', async () => Promise.reject(new Error(`ECONNRESET ${TOKEN}`))).catch((e: Error) => e.message);
    expect(down).toBe('Couldn’t reach api.heroku.com from the controller.');
  });

  it('reads only the config vars for the data copy, dropping unset ones', async () => {
    const h = fakeHeroku(APP);
    expect(await readHerokuConfigVars(TOKEN, 'acme-shop', h.fetchImpl)).toEqual({ NODE_ENV: 'production' });
    expect(h.calls.map((c) => c.url)).toEqual(['https://api.heroku.com/apps/acme-shop/config-vars']);
  });
});
