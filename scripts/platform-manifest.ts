#!/usr/bin/env bun
/**
 * Generate (and optionally sign) the platform release manifest `platform.json`
 * from the pinned BOM in packages/core/src/system-images.ts plus the digests CI
 * just built — never a second hand-kept list (plans/epic-platform-upgrades.md §1).
 *
 *   bun scripts/platform-manifest.ts \
 *     --version 1.2.0 --channel stable --commit "$GITHUB_SHA" --tag 1.2.0 \
 *     --digest controller=sha256:… --digest agent=sha256:… \
 *     --digest dns=sha256:… --digest caddySwarmy=sha256:… \
 *     [--image controller=10.0.0.5:5000/swarmy-controller]   # fork / e2e local registry
 *     [--min-upgrade-from 1.0.0] [--notes-from-git v1.1.0..HEAD] [--notes notes.json]
 *     [--sign-key release.pem [--sign-pass …]]                # PEM signing (self-builders, e2e)
 *     --out platform.json
 *
 * The file is written as CANONICAL JSON (sorted keys, no whitespace) — the
 * exact bytes the release key signs. CI signs it with cosign:
 *
 *   cosign sign-blob --yes --key env://SWARMY_RELEASE_KEY --tlog-upload=false \
 *     --output-signature platform.json.sig platform.json
 *
 * `--sign-key` produces the same signature format with node:crypto (for an
 * e2e harness or a self-builder without cosign), written to `<out>.sig`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  PLATFORM_MIGRATIONS,
  buildPlatformManifest,
  canonicalManifestJson,
  type PlatformChannel,
  type PlatformNote,
} from '../packages/core/src/platform-manifest';
import { signPlatformManifest } from '../packages/core/src/platform-verify';
import type { SystemImageKey } from '../packages/core/src/system-images';

function args(argv: string[]) {
  const one: Record<string, string> = {};
  const many: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith('--')) throw new Error(`unexpected argument ${k}`);
    const [name, inline] = k.slice(2).split('=', 2) as [string, string | undefined];
    const v = inline ?? argv[++i] ?? '';
    if (name === 'digest' || name === 'image') (many[name] ??= []).push(v);
    else one[name] = v;
  }
  return { one, many };
}

function kv(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of list ?? []) {
    const eq = e.indexOf('=');
    if (eq <= 0) throw new Error(`expected key=value, got ${e}`);
    const v = e.slice(eq + 1).trim();
    if (v) out[e.slice(0, eq)] = v;
  }
  return out;
}

/** Conventional commits in a range → release notes (feat → new, fix → fix, perf → better). */
function notesFromGit(range: string): PlatformNote[] {
  const r = Bun.spawnSync(['git', 'log', '--no-merges', '--format=%s', range]);
  if (r.exitCode !== 0) return [];
  const notes: PlatformNote[] = [];
  for (const line of r.stdout.toString().split('\n')) {
    const m = /^(feat|fix|perf|security)(\([^)]*\))?(!)?:\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const kind = m[3] ? 'breaking' : m[1] === 'feat' ? 'new' : m[1] === 'perf' ? 'better' : m[1] === 'security' ? 'security' : 'fix';
    notes.push({ kind, text: m[4]! });
  }
  return notes.slice(0, 200);
}

const { one, many } = args(process.argv.slice(2));
if (!one.version) throw new Error('--version is required');
const channel = (one.channel ?? 'stable') as PlatformChannel;
if (channel !== 'stable' && channel !== 'edge') throw new Error('--channel must be stable or edge');

const notes: PlatformNote[] = [
  ...(one.notes ? (JSON.parse(readFileSync(one.notes, 'utf8')) as PlatformNote[]) : []),
  ...(one['notes-from-git'] ? notesFromGit(one['notes-from-git']) : []),
];

const manifest = buildPlatformManifest({
  version: one.version.replace(/^v/, ''),
  channel,
  commit: one.commit ?? '',
  tag: one.tag,
  minUpgradeFrom: one['min-upgrade-from'],
  digests: kv(many.digest) as Partial<Record<SystemImageKey, string>>,
  images: kv(many.image) as Partial<Record<SystemImageKey, string>>,
  migrations: PLATFORM_MIGRATIONS,
  notes,
});

const body = canonicalManifestJson(manifest);
const out = one.out ?? 'platform.json';
writeFileSync(out, body);
if (one['sign-key']) {
  let sig: string;
  try {
    sig = signPlatformManifest(manifest, readFileSync(one['sign-key'], 'utf8'), one['sign-pass']);
  } catch (e) {
    throw new Error(
      `--sign-key must be a PEM private key (PKCS#8/SEC1 EC or Ed25519); for a cosign.key use \`cosign sign-blob\`: ${e instanceof Error ? e.message : e}`,
    );
  }
  writeFileSync(`${out}.sig`, sig);
}
const missing = Object.entries(manifest.components)
  .filter(([, c]) => !c.digest)
  .map(([k]) => k);
console.log(
  `platform.json ${manifest.version} (${channel}) → ${out}: ${Object.keys(manifest.components).length} components` +
    (missing.length ? `; unresolved: ${missing.join(', ')}` : ''),
);
