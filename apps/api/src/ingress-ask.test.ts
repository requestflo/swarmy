import { describe, expect, it, beforeEach } from 'bun:test';
import { checkOnDemand, normalizeHost, _resetAskCache } from './ingress-ask';

/** Minimal db stub matching the `Pick<PrismaClient, 'domain'>` shape used. */
function dbWith(hosts: string[]) {
  return {
    domain: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async (args: any) => {
        const wanted = args?.where?.host as string;
        return hosts.includes(wanted) ? { id: `dom_${wanted}` } : null;
      },
    },
  } as never;
}

describe('normalizeHost', () => {
  it('lowercases and strips trailing dot + port', () => {
    expect(normalizeHost('App.Example.COM')).toBe('app.example.com');
    expect(normalizeHost('app.example.com.')).toBe('app.example.com');
    expect(normalizeHost('app.example.com:443')).toBe('app.example.com');
  });
});

describe('checkOnDemand', () => {
  beforeEach(() => _resetAskCache());

  it('200 for a registered domain', async () => {
    const res = await checkOnDemand(dbWith(['app.example.com']), 'app.example.com');
    expect(res.status).toBe(200);
  });

  it('matches case-insensitively', async () => {
    const res = await checkOnDemand(dbWith(['app.example.com']), 'APP.example.com');
    expect(res.status).toBe(200);
  });

  it('403 (deny-by-default) for an unknown domain', async () => {
    const res = await checkOnDemand(dbWith(['app.example.com']), 'evil.attacker.com');
    expect(res.status).toBe(403);
  });

  it('400 for a missing or malformed domain', async () => {
    expect((await checkOnDemand(dbWith([]), undefined)).status).toBe(400);
    expect((await checkOnDemand(dbWith([]), 'has space')).status).toBe(400);
    expect((await checkOnDemand(dbWith([]), 'a/b')).status).toBe(400);
  });

  it('serves a positive result from cache without re-hitting the db', async () => {
    let hits = 0;
    const db = {
      domain: {
        findFirst: async () => {
          hits += 1;
          return { id: 'dom_1' };
        },
      },
    } as never;
    await checkOnDemand(db, 'cached.example.com');
    await checkOnDemand(db, 'cached.example.com');
    expect(hits).toBe(1);
  });
});
