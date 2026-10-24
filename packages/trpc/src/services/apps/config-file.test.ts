import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../../context';
import { cachedConfigText, readAppConfigFile, rememberConfigText } from './config-file';

const at = (iso: string) => ({ createdAt: new Date(iso) });

/** A fake ctx: the latest plan per stack, one repo, and plans by trigger. */
function ctxWith(plans: Array<{ stack: string; repoId: string; environment: string; sha: string; trigger: string; createdAt: string }>): OrgContext {
  const newest = <T extends { createdAt: string }>(xs: T[]) => [...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    activeOrgId: 'org1',
    db: {
      appPlan: {
        findFirst: async ({ where }: { where: { stack?: string; trigger?: { in: string[] } } }) => {
          if (where.stack) return newest(plans.filter((p) => p.stack === where.stack)) ?? null;
          const p = newest(plans.filter((x) => where.trigger?.in.includes(x.trigger)));
          return p ? at(p.createdAt) : null;
        },
      },
      gitRepo: {
        findFirst: async ({ where }: { where: { id: string; orgId: string } }) =>
          where.id === 'gr1' && where.orgId === 'org1'
            ? { id: 'gr1', branch: 'main', configPath: 'swarmy.yaml', previewsJson: { baseDomain: 'Preview.Northwind.dev' } }
            : null,
      },
    },
  } as unknown as OrgContext;
}

describe('config-file cache', () => {
  it('remembers text per commit and path', () => {
    rememberConfigText('r-a', 'sha1', 'swarmy.yaml', 'version: 1\n');
    expect(cachedConfigText('r-a', 'sha1', 'swarmy.yaml')?.text).toBe('version: 1\n');
    expect(cachedConfigText('r-a', 'sha2', 'swarmy.yaml')).toBeNull();
    expect(cachedConfigText('r-a', 'sha1', 'apps/x/swarmy.yaml')).toBeNull();
  });

  it('keeps at most 200 commits, dropping the least recently used', () => {
    rememberConfigText('r-lru', 'keep', 'swarmy.yaml', 'kept');
    for (let i = 0; i < 199; i++) rememberConfigText('r-lru', `s${i}`, 'swarmy.yaml', 'x');
    expect(cachedConfigText('r-lru', 'keep', 'swarmy.yaml')?.text).toBe('kept'); // touched → newest
    rememberConfigText('r-lru', 'one-more', 'swarmy.yaml', 'x');
    expect(cachedConfigText('r-lru', 'keep', 'swarmy.yaml')?.text).toBe('kept');
    expect(cachedConfigText('r-lru', 's0', 'swarmy.yaml')).toBeNull();
  });
});

describe('readAppConfigFile', () => {
  it('is null for a stack no git app planned', async () => {
    expect(await readAppConfigFile(ctxWith([]), { stack: 'billing' })).toBeNull();
  });

  it('serves the remembered text of the stack’s last planned commit, with push and poll times', async () => {
    rememberConfigText('gr1', 'b'.repeat(40), 'swarmy.yaml', 'version: 1\napp: storefront\n');
    const ctx = ctxWith([
      { stack: 'storefront', repoId: 'gr1', environment: 'production', sha: 'a'.repeat(40), trigger: 'push', createdAt: '2026-10-24T09:00:00Z' },
      { stack: 'storefront', repoId: 'gr1', environment: 'production', sha: 'b'.repeat(40), trigger: 'poll', createdAt: '2026-10-24T10:00:00Z' },
    ]);
    const view = await readAppConfigFile(ctx, { stack: 'storefront' });
    expect(view).toMatchObject({
      repoId: 'gr1',
      environment: 'production',
      path: 'swarmy.yaml',
      sha: 'b'.repeat(40),
      text: 'version: 1\napp: storefront\n',
      lastWebhookAt: '2026-10-24T09:00:00.000Z',
      lastPollAt: '2026-10-24T10:00:00.000Z',
      previewDomain: 'preview.northwind.dev',
    });
  });
});
