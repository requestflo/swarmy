import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * QA-061: one exact Bun everywhere. The images floated on `oven/bun:1.3-*` while
 * CI tested on 1.3.10, so the runtime that crashed in production (1.3.14) was
 * never the one the tests ran on. Every image and CI job pins the SAME exact
 * version as package.json's packageManager.
 */
const ROOT = path.resolve(import.meta.dir, '../../../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const want = /"packageManager": "bun@(\d+\.\d+\.\d+)"/.exec(read('package.json'))![1]!;

describe('Bun is pinned exactly and consistently', () => {
  it('every Dockerfile uses oven/bun:<exact>', () => {
    for (const f of ['apps/api/Dockerfile', 'apps/agent/Dockerfile', 'apps/dns/Dockerfile', 'apps/web/Dockerfile', 'docker/app-auth/Dockerfile']) {
      const tags = [...read(f).matchAll(/oven\/bun:([^\s]+)/g)].map((m) => m[1] ?? '');
      expect(tags.length).toBeGreaterThan(0);
      for (const t of tags) expect(t.startsWith(`${want}-`)).toBe(true);
    }
  });

  it('every CI job runs the same version', () => {
    for (const f of ['ci.yml', 'images.yml', 'release.yml', 'pr-title.yml', 'e2e-cluster.yml']) {
      const versions = [...read(`.github/workflows/${f}`).matchAll(/bun-version: (\S+)/g)].map((m) => m[1]);
      for (const v of versions) expect(v).toBe(want);
    }
  });
});
