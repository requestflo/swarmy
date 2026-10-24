import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAppConfig } from '@swarmy/app-config';
import { checkRepo, formatCheckReport, memoryRepoFs, nodeRepoFs } from '../src/check';

// A Next.js app on Postgres + Redis that has no swarmy.yaml yet (inline, golden style).
const REPO: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'storefront',
      scripts: { build: 'next build', start: 'next start', 'db:migrate': 'drizzle-kit migrate' },
      dependencies: { next: '15.0.0', 'drizzle-orm': '0.33.0', postgres: '3.4.4', ioredis: '5.4.1' },
    },
    null,
    2,
  ),
  'package-lock.json': '{}',
  '.env.example': 'DATABASE_URL=postgres://localhost:5432/storefront\nREDIS_URL=redis://localhost:6379\n',
  'src/lib/cache.ts': "import Redis from 'ioredis';\n\nexport const redis = new Redis(process.env.REDIS_URL!);\n",
  'src/lib/db.ts': "import postgres from 'postgres';\nexport const sql = postgres(process.env.DATABASE_URL!);\n",
  'node_modules/ioredis/index.js': 'new Redis()',
};

describe('check: what the code needs', () => {
  test('finds Postgres and the cache with file:line evidence, and suggests a swarmy.yaml wired to them', async () => {
    const r = await checkRepo(memoryRepoFs(REPO));
    expect(r.needs.map((d) => `${d.id} → ${d.maps}`)).toEqual(['web → services.web', 'postgres → resources.db', 'cache → resources.cache']);
    expect(r.needs.find((d) => d.id === 'web')).toMatchObject({ port: 3000, evidence: [{ file: 'package.json', line: 9 }] });
    expect(r.needs.find((d) => d.id === 'postgres')).toMatchObject({ release: 'npm run db:migrate', env: ['DATABASE_URL'] });
    expect(r.needs.find((d) => d.id === 'cache')!.evidence.map((e) => `${e.file}:${e.line}`)).toEqual(['package.json:12', 'src/lib/cache.ts:3', '.env.example:2']);
    // node_modules is never read; manifests + two source files are.
    expect(r.scanned).toBe(4);
    const cfg = parseAppConfig(r.suggestedConfig!).config!;
    expect(cfg.env).toEqual({ DATABASE_URL: '${{ db.url }}', REDIS_URL: '${{ cache.url }}' });
    expect(cfg.services.web).toMatchObject({ build: '.', port: 3000, release: 'npm run db:migrate' });
    expect(r.suggestedConfig).not.toContain('postgres://');
    expect(formatCheckReport(r)).toContain('Postgres                   → resources.db             package.json:11  "postgres": "3.4.4",');
  });

  test('the local disk (CLI, stdio MCP) and sent files (HTTP MCP) give the same detections', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'swarmy-needs-'));
    for (const [p, text] of Object.entries(REPO)) {
      await mkdir(path.dirname(path.join(root, p)), { recursive: true });
      await writeFile(path.join(root, p), text);
    }
    const disk = await checkRepo(nodeRepoFs(root));
    const sent = await checkRepo(memoryRepoFs(REPO));
    expect(disk.needs).toEqual(sent.needs);
    expect(disk.suggestedConfig).toBe(sent.suggestedConfig);
  });

  test('a repo with swarmy.yaml still reports its needs', async () => {
    const r = await checkRepo(
      memoryRepoFs({ ...REPO, 'swarmy.yaml': 'version: 1\napp: storefront\nservices:\n  web:\n    build: .\n    port: 3000\n' }),
    );
    expect(r.mode).toBe('swarmy.yaml');
    expect(r.needs.map((d) => d.kind)).toEqual(['web', 'postgres', 'cache']);
    expect(r.suggestedConfig).toBeUndefined();
  });
});
