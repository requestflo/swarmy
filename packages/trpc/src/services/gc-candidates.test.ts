import { describe, expect, it } from 'bun:test';
import type { DB } from '@swarmy/db';
import { loadGcCandidates, repoOfImage } from './gc-candidates';

const D = `sha256:${'a'.repeat(64)}`;

describe('repoOfImage', () => {
  it('strips the registry host, tag and digest', () => {
    expect(repoOfImage(`localhost:5000/team/app@${D}`)).toBe('team/app');
    expect(repoOfImage('localhost:5000/app:main')).toBe('app');
    expect(repoOfImage(`swarmy-registry:5000/app:abc123@${D}`)).toBe('app');
    expect(repoOfImage('registry.example.com/x/y:1')).toBe('x/y');
  });
  it('keeps a hostless path whole', () => {
    expect(repoOfImage('library/nginx:1.27')).toBe('library/nginx');
    expect(repoOfImage('nginx')).toBe('nginx');
  });
});

describe('loadGcCandidates', () => {
  it('maps successful builds to digest + repo candidates', async () => {
    const db = {
      build: {
        findMany: async () => [
          { id: 'b1', image: `localhost:5000/app@${D}`, finishedAt: new Date(0) },
          { id: 'b2', image: 'localhost:5000/app:main', finishedAt: null },
        ],
      },
    } as unknown as DB;
    expect(await loadGcCandidates(db, 'o1')).toEqual([
      { buildId: 'b1', digest: D, finishedAt: new Date(0), repo: 'app' },
      { buildId: 'b2', digest: null, finishedAt: null, repo: 'app' },
    ]);
  });
});
