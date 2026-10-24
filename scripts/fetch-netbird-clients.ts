// SPDX-License-Identifier: FSL-1.1-ALv2
// Fetch the NetBird desktop installers the controller mirrors for "Connect from
// your laptop" (plans/epic-self-hosted-mesh-and-fleets.md §3.4, M3) and write
// the manifest the controller serves them from (/install/netbird/*).
//
// Run: bun run scripts/fetch-netbird-clients.ts <outDir>
//
// Every file is checked against the sha256 pinned in
// packages/mesh/src/client-downloads.ts (NetBird's checksums.txt doesn't cover
// the .pkg/.exe installers). BEST-EFFORT: a file that can't be fetched or
// doesn't match is left out and the script still exits 0, so a build without
// egress ships without the mirror and the dashboard links upstream instead.
//
// Output:
//   <outDir>/<release asset name>   one file per fetched installer
//   <outDir>/manifest.json          { version, files: { <name>: { sha256, size } } }
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  NETBIRD_CLIENT_DOWNLOADS,
  NETBIRD_CLIENT_DOWNLOAD_VERSION,
  upstreamClientUrl,
  type ClientMirrorManifest,
} from '../packages/mesh/src/client-downloads';

const outDir = path.resolve(process.argv[2] ?? 'netbird-clients');
const base = process.env.NETBIRD_CLIENT_BASE_URL?.replace(/\/+$/, '');

await mkdir(outDir, { recursive: true });
const manifest: ClientMirrorManifest = { version: NETBIRD_CLIENT_DOWNLOAD_VERSION, files: {} };

for (const a of NETBIRD_CLIENT_DOWNLOADS) {
  const url = base ? `${base}/${a.file}` : upstreamClientUrl(a.file);
  const dest = path.join(outDir, a.file);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== a.sha256) throw new Error(`sha256 ${sha256} != pinned ${a.sha256}`);
    await writeFile(dest, bytes, { mode: 0o644 });
    manifest.files[a.file] = { sha256, size: bytes.byteLength };
    console.log(`netbird-clients: ${a.file} ok (${bytes.byteLength} bytes)`);
  } catch (e) {
    await rm(dest, { force: true });
    console.warn(`netbird-clients: ${a.file} skipped — ${e instanceof Error ? e.message : String(e)}`);
  }
}

await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`netbird-clients: ${Object.keys(manifest.files).length}/${NETBIRD_CLIENT_DOWNLOADS.length} mirrored into ${outDir}`);
