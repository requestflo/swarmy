#!/usr/bin/env bun
/**
 * Pin the BOM's upstream-floating images for a release: the data section's
 * engines (managed Postgres at every offered major, Redis, Meilisearch,
 * Typesense, Qdrant) and helpers follow their upstream tag in
 * packages/core/src/system-images-data.ts, so the release's platform.json is
 * where they get a digest. The manifest job runs this before
 * scripts/platform-manifest.ts:
 *
 *   bun scripts/data-image-digests.ts [out-dir]
 *
 * → one `digest-data-<key>.txt` per image (`<key>=sha256:…`, the multi-arch
 * index digest from `docker buildx imagetools inspect`), next to the own
 * builds' digest files, so `--digest "$(cat digest-*.txt)"` takes them all.
 *
 * Fails when any tag doesn't resolve: a release that names a data image
 * without its digest can't be bundled, and its nodes would deploy by tag.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_IMAGES, parseImageRef } from '../packages/core/src/system-images';

const out = process.argv[2] ?? '.';
mkdirSync(out, { recursive: true });
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const failed: string[] = [];
for (const img of SYSTEM_IMAGES.filter((i) => i.upstream && !i.digest)) {
  const p = parseImageRef(img.ref);
  const src = `${p.host}/${p.path}:${p.tag ?? 'latest'}`;
  let digest = '';
  let r: ReturnType<typeof Bun.spawnSync> | undefined;
  for (let attempt = 1; attempt <= 3 && !DIGEST.test(digest); attempt++) {
    if (attempt > 1) Bun.sleepSync(2_000 * attempt); // a registry hiccup is not a missing tag
    r = Bun.spawnSync(['docker', 'buildx', 'imagetools', 'inspect', src, '--format', '{{json .Manifest}}'], { stderr: 'pipe' });
    try {
      digest = (JSON.parse(r.stdout!.toString()) as { digest?: string }).digest ?? '';
    } catch {
      digest = '';
    }
  }
  if (!r || r.exitCode !== 0 || !DIGEST.test(digest)) {
    failed.push(`${img.key} (${src}): ${r?.stderr?.toString().trim().split('\n').pop() || 'no digest'}`);
    continue;
  }
  writeFileSync(join(out, `digest-data-${img.key}.txt`), `${img.key}=${digest}`);
  console.log(`${img.key}=${digest}  ${src}`);
}
if (failed.length) {
  console.error(`could not resolve ${failed.length} data image(s):\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
