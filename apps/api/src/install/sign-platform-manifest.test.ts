import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// QA-019: the manifest job must fail loudly without the release key and never
// leave a 0-byte .sig behind to publish.
const ROOT = path.resolve(import.meta.dir, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/sign-platform-manifest.sh');

function run(env: Record<string, string>, cosign: string | null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-sign-'));
  const manifest = path.join(dir, 'platform.json');
  writeFileSync(manifest, '{"version":"1.2.3"}');
  const bin = path.join(dir, 'bin');
  Bun.spawnSync(['mkdir', '-p', bin]);
  if (cosign !== null) {
    writeFileSync(path.join(bin, 'cosign'), cosign);
    chmodSync(path.join(bin, 'cosign'), 0o755);
  }
  const r = Bun.spawnSync(['bash', SCRIPT, manifest], {
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const sig = `${manifest}.sig`;
  return { code: r.exitCode, err: r.stderr.toString(), sig: existsSync(sig) ? readFileSync(sig, 'utf8') : null };
}

// A cosign stand-in: writes the given signature to --output-signature.
const fakeCosign = (out: string) =>
  `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --output-signature ] && { shift; printf '%s' '${out}' > "$1"; }; shift; done\n`;

describe('sign-platform-manifest.sh', () => {
  it('no SWARMY_RELEASE_KEY: fails with a clear error and writes no .sig', () => {
    const r = run({}, fakeCosign('SIG'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('::error');
    expect(r.err).toContain('SWARMY_RELEASE_KEY secret is not set');
    expect(r.sig).toBeNull();
  });

  it('an empty signature from cosign fails and leaves nothing to publish', () => {
    const r = run({ SWARMY_RELEASE_KEY: 'k' }, fakeCosign(''));
    expect(r.code).toBe(1);
    expect(r.err).toContain('empty signature');
    expect(r.sig).toBeNull();
  });

  it('a real signature passes', () => {
    const r = run({ SWARMY_RELEASE_KEY: 'k' }, fakeCosign('MEUCIQ-signature'));
    expect(r.code).toBe(0);
    expect(r.sig).toBe('MEUCIQ-signature');
  });

  it('the workflow uses the script and guards the publish', () => {
    const wf = readFileSync(path.join(ROOT, '.github/workflows/images.yml'), 'utf8');
    expect(wf).toContain('bash scripts/sign-platform-manifest.sh platform.json');
    expect(wf).toContain('[ -s platform.json.sig ] ||');
    expect(wf).not.toContain(': > platform.json.sig');
  });
});
