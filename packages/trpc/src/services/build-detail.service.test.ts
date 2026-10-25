import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { getBuild } from './build-detail.service';

/** The build page's version (board 27): read from the tag or its recorded Release, never invented. Mock db. */

const SHA = '4e1c09a7b2d3e5f60718293a4b5c6d7e8f901234';

function ctxWith(build: Record<string, unknown>, releaseImages: unknown) {
  const asked: Array<Record<string, unknown>> = [];
  const db = {
    build: {
      findFirst: async () => ({
        id: 'b1', repoId: 'r1', status: 'SUCCEEDED', logsRef: null, startedAt: null, finishedAt: null,
        repo: { url: 'https://git.example.com/acme/shop.git' }, stages: [], releaseId: null, ...build,
      }),
      findMany: async () => [],
    },
    release: {
      findFirst: async (q: Record<string, unknown>) => {
        asked.push(q);
        return { imagesJson: releaseImages };
      },
    },
  };
  return { ctx: { db, activeOrgId: 'org-1' } as unknown as OrgContext, asked };
}

describe('getBuild version', () => {
  it('reads a version-tagged image in the build’s Release, org-scoped', async () => {
    const { ctx, asked } = ctxWith(
      { commit: SHA, image: `localhost:5000/shop:${SHA.slice(0, 12)}`, releaseId: 'rel-1' },
      [{ name: 'web', image: 'ghcr.io/acme/web:2.3.1@sha256:abc' }],
    );
    expect((await getBuild(ctx, 'b1')).version).toBe('v2.3.1');
    expect(asked[0]).toMatchObject({ where: { id: 'rel-1', orgId: 'org-1' } });
  });

  it('takes a tag build’s ref, and is null for a commit deployed by digest', async () => {
    expect((await getBuild(ctxWith({ commit: 'v1.4.0', image: 'localhost:5000/shop:v1.4.0' }, []).ctx, 'b1')).version).toBe('v1.4.0');
    const digestOnly = ctxWith({ commit: SHA, image: 'localhost:5000/shop@sha256:abc', releaseId: 'rel-2' }, [{ image: 'localhost:5000/shop@sha256:abc' }]);
    expect((await getBuild(digestOnly.ctx, 'b1')).version).toBeNull();
  });
});
