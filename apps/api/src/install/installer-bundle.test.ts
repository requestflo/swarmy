import { describe, expect, it } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlatformManifest, canonicalManifestJson } from '@swarmy/core/platform-manifest';
import { BUILT_IN_RELEASE_PUBKEY } from '@swarmy/core/platform-verify';
import type { SystemImage } from '@swarmy/core/system-images';

// install-swarmy.sh --bundle: the air-gapped install's pure helpers, run for real by sourcing the script.
const ROOT = path.resolve(import.meta.dir, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/install-swarmy.sh');
const STACK = path.join(ROOT, 'deploy/swarmy.lite.stack.yml');

function sh(expr: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['bash', '-c', `. "$0"; ${expr}`, SCRIPT], { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode ?? -1 };
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A bundle dir: two images (an OCI index, swarmy's own build as a Docker list), signed platform.json. */
function bundle() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-bundle-'));
  const blobs = path.join(dir, 'oci/blobs/sha256');
  mkdirSync(blobs, { recursive: true });
  const caddyIdx = '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}';
  const ctrlIdx = '{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.list.v2+json","manifests":[]}';
  for (const b of [caddyIdx, ctrlIdx]) writeFileSync(path.join(blobs, sha(b)), b);
  const bom = [
    { key: 'caddy', ref: 'caddy:2-alpine', digest: `sha256:${sha(caddyIdx)}` },
    { key: 'controller', ref: 'ghcr.io/requestflo/swarmy-controller:latest' },
    { key: 'agent', ref: 'ghcr.io/requestflo/swarmy-agent:latest' }, // unresolved: never named
  ] as SystemImage[];
  const m = buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'c', tag: '1.3.0', digests: { controller: `sha256:${sha(ctrlIdx)}` }, bom });
  const raw = canonicalManifestJson(m);
  writeFileSync(path.join(dir, 'platform.json'), raw);
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(path.join(dir, 'platform.json.sig'), sign('sha256', Buffer.from(raw), kp.privateKey).toString('base64'));
  const pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { dir, blobs, pub, ctrl: `sha256:${sha(ctrlIdx)}`, caddy: `sha256:${sha(caddyIdx)}`, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('install-swarmy.sh --bundle (air-gapped install)', () => {
  it('parses, embeds the controller release key, and wires the flag through to the controller', () => {
    expect(Bun.spawnSync(['bash', '-n', SCRIPT]).exitCode).toBe(0);
    expect(sh('printf %s "$BUILT_IN_RELEASE_PUBKEY"').out).toBe(BUILT_IN_RELEASE_PUBKEY.trim());
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('--bundle) BUNDLE="${2:?}"');
    expect(script).toContain('[ -n "$BUNDLE" ] || marker_done egress');
    expect(script).toContain('SWARMY_BUNDLE_VOLUME="$BUNDLE_HANDOFF"');
    expect(script).toContain('${BUNDLE:+--resolve-image never}');
    expect(script).not.toMatch(/docker pull "\$(NETBIRD_IMAGE|AGENT_IMAGE|MESH_CONTROL_IMAGE)"/);
    expect(readFileSync(STACK, 'utf8')).toContain('SWARMY_BUNDLE_VOLUME: ${SWARMY_BUNDLE_VOLUME:-}');
  }, 30_000);

  it('verifies platform.json with the release key, as the controller does', () => {
    const b = bundle();
    try {
      expect(sh(`bundle_verify "${b.dir}"`, { SWARMY_RELEASE_PUBKEY: b.pub }).code).toBe(0);
      expect(sh(`bundle_verify "${b.dir}"`).code).not.toBe(0); // the built-in key did not sign it
      writeFileSync(path.join(b.dir, 'platform.json'), readFileSync(path.join(b.dir, 'platform.json'), 'utf8').replace('"commit":"c"', '"commit":"x"'));
      expect(sh(`bundle_verify "${b.dir}"`, { SWARMY_RELEASE_PUBKEY: b.pub }).code).not.toBe(0);
    } finally {
      b.done();
    }
  }, 30_000);

  it('lists the signed components and pins the controller/agent/mesh images to them', () => {
    const b = bundle();
    try {
      const lines = sh(`bundle_components "${b.dir}/platform.json"`).out.trim().split('\n');
      expect(lines).toEqual([
        `caddy caddy:2-alpine docker.io/library/caddy 2-alpine ${b.caddy}`,
        `controller ghcr.io/requestflo/swarmy-controller:latest ghcr.io/requestflo/swarmy-controller 1.3.0 ${b.ctrl}`,
      ]);
      expect(sh(`bundle_pin_images "${b.dir}/platform.json"; printf %s "$IMAGE"`).out).toBe(`ghcr.io/requestflo/swarmy-controller:1.3.0@${b.ctrl}`);
      expect(sh(`bundle_pin_images "${b.dir}/platform.json"; printf %s "$IMAGE"`, { SWARMY_IMAGE: 'mine:1' }).out).toBe('mine:1');
    } finally {
      b.done();
    }
  }, 30_000);

  it('names every image for docker load by the refs swarmy runs; refuses a missing or altered image', () => {
    const b = bundle();
    try {
      const idx = JSON.parse(sh(`bundle_index "${b.dir}"`).out) as { manifests: Array<{ mediaType: string; digest: string; annotations: Record<string, string> }> };
      expect(idx.manifests.map((d) => [d.annotations['io.containerd.image.name'], d.digest, d.mediaType])).toEqual([
        ['docker.io/library/caddy:2-alpine', b.caddy, 'application/vnd.oci.image.index.v1+json'],
        ['ghcr.io/requestflo/swarmy-controller:latest', b.ctrl, 'application/vnd.docker.distribution.manifest.list.v2+json'],
        ['ghcr.io/requestflo/swarmy-controller:1.3.0', b.ctrl, 'application/vnd.docker.distribution.manifest.list.v2+json'],
      ]);
      writeFileSync(path.join(b.blobs, b.caddy.slice(7)), '{"tampered":true}');
      expect(sh(`bundle_index "${b.dir}"`)).toMatchObject({ code: 1, err: expect.stringContaining('does not match its signed digest') });
      rmSync(path.join(b.blobs, b.caddy.slice(7)));
      expect(sh(`bundle_index "${b.dir}"`)).toMatchObject({ code: 1, err: expect.stringContaining('has no caddy') });
    } finally {
      b.done();
    }
  }, 30_000);

  it('skips only the images a bundle built --without lists in omitted.txt', () => {
    const b = bundle();
    try {
      rmSync(path.join(b.blobs, b.caddy.slice(7)));
      writeFileSync(path.join(b.dir, 'omitted.txt'), '# left out with --without data-images\ncaddy\n');
      const r = sh(`bundle_index "${b.dir}"`);
      expect(r.code).toBe(0);
      expect(r.err).toContain('leaves out caddy');
      const idx = JSON.parse(r.out) as { manifests: Array<{ annotations: Record<string, string> }> };
      expect(idx.manifests.map((d) => d.annotations['io.containerd.image.name'])).toEqual([
        'ghcr.io/requestflo/swarmy-controller:latest',
        'ghcr.io/requestflo/swarmy-controller:1.3.0',
      ]);
      writeFileSync(path.join(b.dir, 'omitted.txt'), 'caddy-old\n'); // a whole line, never a prefix
      expect(sh(`bundle_index "${b.dir}"`)).toMatchObject({ code: 1, err: expect.stringContaining('has no caddy') });
    } finally {
      b.done();
    }
  }, 30_000);

  it('only unpacks a tar of plain files under swarmy-bundle/', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-bundle-tar-'));
    try {
      mkdirSync(path.join(dir, 'swarmy-bundle/oci'), { recursive: true });
      writeFileSync(path.join(dir, 'swarmy-bundle/platform.json'), '{}');
      writeFileSync(path.join(dir, 'other.txt'), 'x');
      const tar = (name: string, ...members: string[]) => {
        Bun.spawnSync(['tar', '-cf', path.join(dir, name), '-C', dir, ...members]);
        return path.join(dir, name);
      };
      expect(sh(`bundle_tar_safe "${tar('ok.tar', 'swarmy-bundle')}"`).code).toBe(0);
      expect(sh(`bundle_tar_safe "${tar('extra.tar', 'swarmy-bundle', 'other.txt')}"`).code).not.toBe(0);
      symlinkSync('/etc/passwd', path.join(dir, 'swarmy-bundle/oci/link'));
      expect(sh(`bundle_tar_safe "${tar('link.tar', 'swarmy-bundle')}"`).code).not.toBe(0);
      expect(sh(`bundle_tar_safe "${path.join(dir, 'other.txt')}"`).code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
