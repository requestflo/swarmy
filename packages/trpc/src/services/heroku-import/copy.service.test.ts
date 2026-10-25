import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../../context';
import { copyHerokuDatabase } from './copy.service';
import { resolveHeroku } from './source';

const paste = (config: string) => ({
  kind: 'paste' as const,
  appJson: JSON.stringify({ name: 'acme-shop', addons: ['heroku-postgresql:standard-0'] }),
  procfile: 'web: npm start',
  config,
  domains: '',
});
const URL_OK = "DATABASE_URL='postgres://u1:pw@ec2-1.compute-1.amazonaws.com:5432/d1'";

/** No primary running: the hub's inventory is empty, and nothing may be dispatched. */
const ctx = {
  activeOrgId: 'org1',
  hub: {
    liveInventory: () => ({ services: [], containers: [] }),
    dispatch: async () => {
      throw new Error('must not dispatch');
    },
  },
} as unknown as OrgContext;

describe('copyHerokuDatabase: the refusals come before anything runs', () => {
  it('needs the typed phrase <stack>/<cluster>, before it even reads Heroku', async () => {
    let read = false;
    const resolve = async (...a: Parameters<typeof resolveHeroku>) => ((read = true), resolveHeroku(...a));
    const e = await copyHerokuDatabase(ctx, { source: paste(URL_OK), stack: 'acme-shop', cluster: 'db', confirm: 'db' }, resolve).catch((x: Error) => x);
    expect((e as Error).message).toBe('Type acme-shop/db to copy the data.');
    expect(read).toBe(false);
  });

  it('refuses an unknown database, a missing DATABASE_URL, and a database Deploy hasn’t started', async () => {
    const run = (config: string, cluster = 'db') =>
      copyHerokuDatabase(ctx, { source: paste(config), stack: 'acme-shop', cluster, confirm: `acme-shop/${cluster}` }).catch((x: Error) => x.message);
    expect(await run(URL_OK, 'cache')).toBe('The import has no database called cache.');
    expect(await run("DATABASE_URL='mysql://x'")).toContain('DATABASE_URL isn’t in the Heroku config');
    expect(await run(URL_OK)).toBe('db isn’t running yet: press Deploy first.');
  });
});
