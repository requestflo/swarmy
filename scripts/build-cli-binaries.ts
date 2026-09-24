// SPDX-License-Identifier: FSL-1.1-ALv2
// Compile the `swarmy` developer CLI to standalone binaries + a sha256 manifest.
//
// The controller serves them itself at `<controller>/install/cli/<platform>`
// (see apps/api/src/devx.ts), next to `/install/cli.sh`, the same
// self-hosted path the agent binaries take at /install/bin.
//
// Run: bun run scripts/build-cli-binaries.ts [outDir]
//   outDir defaults to apps/cli/dist-bin. Targets via CLI_BIN_TARGETS
//   (comma-separated), default darwin-arm64,darwin-x64,linux-arm64,linux-x64;
//   `host` = this machine's platform.
//
// Output:
//   <outDir>/swarmy-<platform>   one binary per target
//   <outDir>/manifest.json       { version, commit?, platforms: { <platform>: { sha256, size } } }
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'apps/cli/dist-bin');
const ENTRY = path.join(ROOT, 'apps/cli/src/main.ts');

const hostPlatform = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const targets = (process.env.CLI_BIN_TARGETS ?? 'darwin-arm64,darwin-x64,linux-arm64,linux-x64')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean)
  .map((t) => (t === 'host' ? hostPlatform : t));

const pkg = (await Bun.file(path.join(ROOT, 'apps/cli/package.json')).json()) as { version: string };
const version = process.env.SWARMY_VERSION || pkg.version;
const commit = process.env.SWARMY_COMMIT ?? '';

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const platforms: Record<string, { sha256: string; size: number }> = {};
for (const platform of targets) {
  const outfile = path.join(OUT_DIR, `swarmy-${platform}`);
  console.log(`==> compiling swarmy for ${platform}`);
  const proc = Bun.spawn(
    [
      'bun',
      'build',
      '--compile',
      '--minify',
      `--target=bun-${platform}`,
      ENTRY,
      '--outfile',
      outfile,
      `--define=process.env.SWARMY_CLI_VERSION=${JSON.stringify(version)}`,
      // A stray .env in the directory the developer runs `swarmy` from must
      // never configure the CLI (it would also leak into `swarmy run`).
      '--compile-exec-argv=--env-file=/dev/null',
    ],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await proc.exited) !== 0) {
    console.error(`compile failed for ${platform}`);
    process.exit(1);
  }
  const bytes = await Bun.file(outfile).arrayBuffer();
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  platforms[platform] = { sha256: hasher.digest('hex'), size: bytes.byteLength };
}

await Bun.write(
  path.join(OUT_DIR, 'manifest.json'),
  `${JSON.stringify({ version, commit: commit || undefined, platforms }, null, 2)}\n`,
);
console.log(`==> wrote ${Object.keys(platforms).length} CLI binaries + manifest.json to ${OUT_DIR}`);
