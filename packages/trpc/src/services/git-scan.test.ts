import { describe, expect, it } from 'bun:test';
import { detectBuild } from './git-providers/detect-build';
import type { InspectResult } from './git-providers/inspect';
import { draftConfig, scanFromInspect, scanProbePaths } from './git-scan';

const PKG = JSON.stringify(
  {
    name: 'orders',
    scripts: { start: 'node dist/server.js', worker: 'node dist/worker.js' },
    dependencies: { fastify: '4.28.0', pg: '8.12.0', ioredis: '5.4.1' },
  },
  null,
  2,
);

/** What git.inspect hands back for services/orders (probes + the source grep), inline. */
const READ: InspectResult = {
  sha: 'f'.repeat(40),
  files: { 'services/orders/swarmy.yaml': null },
  tree: ['services/orders/package.json'],
  probes: {
    'services/orders/package.json': PKG,
    'services/orders/.env.example': 'DATABASE_URL=postgres://localhost/orders\nREDIS_URL=redis://localhost:6379\n',
    'services/orders/pnpm-lock.yaml': '',
  },
  scan: {
    files: ['services/orders/src/queue.ts', 'services/orders/src/server.ts'],
    hits: [{ file: 'services/orders/src/queue.ts', line: 3, text: 'export const redis = new Redis(process.env.REDIS_URL!);' }],
  },
};

describe('scanFromInspect', () => {
  it('runs the shared detectors over probes + grep hits, counting every file read', () => {
    const detected = detectBuild(READ.probes!, 'services/orders');
    const v = scanFromInspect(READ, { dir: 'services/orders', repo: 'https://github.com/northwind/platform.git', detected, ms: 1834 });
    expect(v).toMatchObject({ dir: 'services/orders', app: 'orders', ms: 1834, files: 4 });
    expect(v.detections.map((d) => d.id)).toEqual(['web', 'worker:worker', 'postgres', 'cache']);
    // Fastify's default port, with its dependency line as the evidence.
    expect(v.detections[0]).toMatchObject({ port: 3000, evidence: [{ file: 'services/orders/package.json', line: 8 }] });
    expect(v.detections.find((d) => d.id === 'worker:worker')?.command).toBe('pnpm run worker');
    expect(v.detections.find((d) => d.id === 'cache')?.evidence.map((e) => `${e.file}:${e.line}`)).toContain('services/orders/src/queue.ts:3');
  });

  it('probes the scan manifests in the folder', () => {
    const p = scanProbePaths('services/orders');
    expect(p.probePaths).toContain('services/orders/.env.example');
    expect(p.probePaths).toContain('services/orders/prisma/schema.prisma');
    expect(p.presencePaths).toContain('services/orders/alembic.ini');
  });
});

describe('draftConfig', () => {
  const detected = detectBuild(READ.probes!, 'services/orders');
  const { detections } = scanFromInspect(READ, { dir: 'services/orders', repo: 'x', detected, ms: 1 });
  const all = detections.map((d) => d.id);

  it('is valid by the parser and draws the app toDesired creates', () => {
    const d = draftConfig({ app: 'orders', dir: 'services/orders', detections, selected: all });
    expect(d.valid).toBe(true);
    expect(d.issues).toEqual([]);
    expect(d.yaml).toContain('DATABASE_URL: ${{ db.url }}');
    expect(d.graph).toEqual({
      stack: 'orders',
      services: [
        { name: 'web', meta: 'build · :3000 · 1 copy', wires: ['cache', 'db'] },
        { name: 'worker', meta: 'build · no address · 1 copy', wires: ['cache', 'db'] },
      ],
      data: [
        { name: 'cache', meta: 'valkey · 256 MB' },
        { name: 'db', meta: 'postgres 16 · backed up daily' },
      ],
      jobs: [],
    });
  });

  it('a bad Build · advanced value is the parser’s error, located, and draws nothing', () => {
    const d = draftConfig({ app: 'orders', dir: 'services/orders', detections, selected: [], build: { path: '../escape' } });
    expect(d.valid).toBe(false);
    expect(d.graph).toBeNull();
    expect(d.issues[0]).toMatchObject({ severity: 'error', line: expect.any(Number) });
  });
});
