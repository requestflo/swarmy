/**
 * Build the pre-initialised PGlite data-dir tarball baked into the controller
 * image (lite tier). A fresh node then seeds its data dir from it instead of
 * running PGlite's initdb, whose ~1 GiB RSS peak OOM-killed first boots on 1 GB
 * hosts. See buildPgliteTemplate() and docs/product/footprint.md.
 *
 *   bun run packages/db/scripts/pglite-template.ts <out.tar.gz>
 */
import { writeFile } from 'node:fs/promises';
import { buildPgliteTemplate } from '../src/pglite-adapter';

const out = process.argv[2];
if (!out) {
  console.error('usage: pglite-template.ts <out.tar.gz>');
  process.exit(2);
}
const tarball = await buildPgliteTemplate();
await writeFile(out, tarball);
console.log(`pglite template: wrote ${tarball.byteLength} bytes to ${out}`);
