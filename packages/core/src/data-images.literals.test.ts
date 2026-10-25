import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * No managed-data code path names an image by a literal ref: every engine and
 * helper image comes from the BOM's data section (`system-images-data.ts`,
 * looked up through `data-images.ts`), so a release can pin it, the offline
 * bundle carries it, and an air-gapped install can run it. A grep over the
 * source (comments stripped) for refs of the repos managed data uses.
 */
const ROOT = path.resolve(import.meta.dir, '../../..');
const SCANNED = ['packages/core/src', 'packages/trpc/src', 'apps/agent/src', 'apps/api/src'];
/** The BOM itself: the one place these refs are written. */
const BOM = new Set(['packages/core/src/system-images.ts', 'packages/core/src/system-images-data.ts']);

const REPOS = [
  'postgres', 'postgresql', 'pgvector/pgvector', 'postgis/postgis', 'redis', 'valkey/valkey',
  'getmeili/meilisearch', 'typesense/typesense', 'qdrant/qdrant', 'alpine', 'busybox', 'restic/restic',
  'ghcr\\.io/requestflo/swarmy-walg', 'wal-g/wal-g', 'pgbackrest/pgbackrest', 'mariadb', 'mysql', 'mongo',
  'bitnami(?:legacy)?/[a-z0-9-]+', '(?:[a-z0-9-]+/)?pgbouncer', 'dxflrs/garage', 'curlimages/curl',
];
const REF = new RegExp(`(?<![\\w./-])(?:docker\\.io/)?(?:library/)?(?:${REPOS.join('|')})(?::[A-Za-z0-9_.\${}-]*[A-Za-z0-9_}]|@sha256:)`, 'g');

/** `postgres:postgres` is a `chown` owner in the boot scripts, not an image. */
const OWNER = /^([a-z]+):\1$/;

/** Literals that are not an image swarmy runs for managed data, each with the reason. */
const ALLOWED: Array<{ file: string; ref?: string; why: string }> = [
  { file: 'packages/trpc/src/services/blueprints/catalog.ts', why: "templates: an app's own services, deployed as the user's stack" },
  { file: 'packages/trpc/src/services/search-testing.ts', why: 'a test-only fixture of a running engine' },
  { file: 'packages/core/src/protocol/dbBackup.ts', ref: 'pgbackrest/pgbackrest:2.51', why: 'no upstream image exists to put in the BOM; the engine needs an operator-supplied engineImage' },
  { file: 'packages/trpc/src/services/manageddb-extensions.service.ts', ref: 'postgis/postgis:17-3.5', why: 'an example in an error message, not an image swarmy runs' },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** Drop block and line comments (a `//` after `:` is a URL and stays). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;,{}()])\/\/.*$/gm, '$1');
}

function literalRefs(): Array<{ file: string; ref: string }> {
  const hits: Array<{ file: string; ref: string }> = [];
  for (const dir of SCANNED) {
    for (const abs of sourceFiles(path.join(ROOT, dir))) {
      const file = path.relative(ROOT, abs);
      if (BOM.has(file)) continue;
      for (const m of code(readFileSync(abs, 'utf8')).matchAll(REF)) if (!OWNER.test(m[0])) hits.push({ file, ref: m[0] });
    }
  }
  return hits;
}

describe('managed data names its images through the BOM, never a literal ref', () => {
  const hits = literalRefs();

  it('finds no literal managed-data image ref outside the BOM and the allowlist', () => {
    const stray = hits.filter((h) => !ALLOWED.some((a) => a.file === h.file && (!a.ref || a.ref === h.ref)));
    expect(stray).toEqual([]);
  });

  it('every allowlist entry still matches something (a stale entry hides nothing)', () => {
    for (const a of ALLOWED) expect(hits.some((h) => h.file === a.file && (!a.ref || a.ref === h.ref))).toBe(true);
  });

  it('the grep sees through the forms a literal takes', () => {
    const sample = `const a = 'pgvector/pgvector:pg16'; const b = \`redis:\${v}\`; const c = "docker.io/library/alpine:3.20";
      const d = 'qdrant/qdrant@sha256:${'a'.repeat(64)}'; // 'mysql:8' in a comment
      const e = 'postgres://u@h:5432/db'; const f = { redis: 1 }; /* 'valkey/valkey:8' */ const g = 'http://x//mongo:7';
      const h = 'chown postgres:postgres "$PGDATA"';`;
    expect([...code(sample).matchAll(REF)].map((m) => m[0]).filter((r) => !OWNER.test(r))).toEqual([
      'pgvector/pgvector:pg16',
      'redis:${v}',
      'docker.io/library/alpine:3.20',
      'qdrant/qdrant@sha256:',
    ]);
  });
});
