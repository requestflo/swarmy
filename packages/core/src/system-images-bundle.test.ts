import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUNDLE_MANIFEST_MARKER,
  BUNDLE_NONE_MARKER,
  BUNDLE_SIG_MARKER,
  MIRROR_SKIP_MARKER,
  parseBundleRead,
  parseBundleSkipped,
  renderBundleCopyScript,
  renderBundleReadScript,
} from './system-images-bundle';
import { parseMirrorOutput, type SystemImage } from './system-images';

const HAVE = `sha256:${'a'.repeat(64)}`;
const MISSING = `sha256:${'b'.repeat(64)}`;
const ITEMS: SystemImage[] = [
  { key: 'caddy', ref: 'caddy:2-alpine', digest: HAVE },
  { key: 'netbirdClient', ref: 'ghcr.io/netbirdio/netbird:0.79.0', digest: MISSING },
  { key: 'dns', ref: 'ghcr.io/requestflo/swarmy-dns:latest' }, // floating, no signed digest: never copied
];

/** A bundle root + stub regctl/base64 on PATH that log their argv (runs the real script). */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmy-bundle-'));
  const root = join(dir, 'swarmy-bundle');
  const bin = join(dir, 'bin');
  mkdirSync(join(root, 'oci/blobs/sha256'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(root, 'oci/blobs/sha256', 'a'.repeat(64)), '{"manifests":[]}');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('regctl', `echo "$*" >> "${dir}/regctl.log"\ncase "$1 $2" in "image digest") echo ${HAVE} ;; esac\nexit 0`);
  stub('base64', '[ "$1" = -w0 ] && shift; openssl base64 -A -in "$1"');
  const run = (script: string) => {
    const r = Bun.spawnSync(['sh', '-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdout: 'pipe', stderr: 'pipe' });
    return r.stdout.toString();
  };
  return { dir, root, run, log: () => readFileSync(join(dir, 'regctl.log'), 'utf8'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('bundle seed one-shots (install-swarmy.sh --bundle → the built-in registry)', () => {
  it('reads the signed bytes back exactly (base64, one line each), or says none', () => {
    const s = sandbox();
    try {
      expect(s.run(renderBundleReadScript(s.root)).trim()).toBe(BUNDLE_NONE_MARKER);
      expect(parseBundleRead(s.run(renderBundleReadScript(s.root)))).toBeNull();
      const raw = '{"notes":[{"kind":"new","text":"Mesh → relays"}],"version":"1.3.0"}\n';
      writeFileSync(join(s.root, 'platform.json'), raw);
      writeFileSync(join(s.root, 'platform.json.sig'), 'MEUCIQ==\n');
      const out = s.run(renderBundleReadScript(s.root));
      expect(out).toContain(BUNDLE_MANIFEST_MARKER);
      expect(out).toContain(BUNDLE_SIG_MARKER);
      expect(parseBundleRead(`noise\n${out}`)).toEqual({ manifest: raw, signature: 'MEUCIQ==\n' });
    } finally {
      s.done();
    }
  }, 30_000);

  it('copies by the signed digest from the OCI layout, skips what the bundle lacks', () => {
    const s = sandbox();
    try {
      const script = renderBundleCopyScript(ITEMS, 'localhost:5000', s.root);
      expect(script).not.toContain('swarmy-dns');
      const out = s.run(script);
      expect(parseBundleSkipped(out)).toEqual(['netbirdClient']);
      expect([...parseMirrorOutput(out).ok]).toEqual([['caddy', HAVE]]);
      expect(s.log()).toContain(`image copy ocidir://${s.root}/oci@${HAVE} localhost:5000/swarmy-system/docker.io/library/caddy:2-alpine`);
      expect(s.log()).not.toContain(MISSING);
    } finally {
      s.done();
    }
  }, 30_000);

  it('the login rides env, never the script', () => {
    const script = renderBundleCopyScript(ITEMS, 'localhost:5000');
    expect(script).toContain('--pass-stdin');
    expect(script).toContain('$SWARMY_REG_PASS');
    expect(script).toContain(`ocidir:///bundle/swarmy-bundle/oci@${HAVE}`);
    expect(parseBundleSkipped(`${MIRROR_SKIP_MARKER} caddy\n${MIRROR_SKIP_MARKER}\n`)).toEqual(['caddy']);
  });
});
