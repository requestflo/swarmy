import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPlatformManifest, canonicalManifestJson } from '@swarmy/core/platform-manifest';
import { signPlatformManifest } from '@swarmy/core/platform-verify';
import { RELEASE_VERIFY_SH } from './release-verify-sh';
import { renderInstaller } from './installer';

// H17: run the installer's REAL verification functions under sh, with a fake
// curl that serves local files and the real openssl.
const HAS_OPENSSL = Bun.spawnSync(['sh', '-c', 'command -v openssl']).exitCode === 0;
const SHA_X64 = 'a'.repeat(64);
const AGENT_DIGEST = `sha256:${'d'.repeat(64)}`;

function keys(type: 'ec' | 'ed25519' = 'ec') {
  const kp = type === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
  return {
    pub: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const manifest = buildPlatformManifest({
  version: '1.2.0',
  channel: 'stable',
  commit: 'abc',
  publishedAt: '2026-09-25T00:00:00.000Z',
  bom: [
    { key: 'controller', ref: 'ghcr.io/requestflo/swarmy-controller:latest' },
    { key: 'agent', ref: 'ghcr.io/requestflo/swarmy-agent:latest' },
  ],
  digests: { agent: AGENT_DIGEST },
  agentBinaries: { 'linux-x64': SHA_X64 },
});

interface Served {
  manifest?: string;
  sig?: string;
}

function run(script: string, served: Served, env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-relv-'));
  if (served.manifest !== undefined) writeFileSync(path.join(dir, 'platform.json'), served.manifest);
  if (served.sig !== undefined) writeFileSync(path.join(dir, 'platform.json.sig'), served.sig);
  // curl stand-in: `…/install/release/<file>` → the local file, 22 (HTTP error) when absent.
  writeFileSync(
    path.join(dir, 'curl'),
    `#!/bin/sh\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --proto|--proto-redir) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done\necho "$url" >> "${dir}/curl.log"\nf="${dir}/\${url##*/}"\n[ -f "$f" ] || exit 22\ncp "$f" "$out"\n`,
  );
  chmodSync(path.join(dir, 'curl'), 0o755);
  const body = `set -eu
say()  { printf 'SAY %s\\n' "$1"; }
ok()   { printf 'OK %s\\n' "$1"; }
warn() { printf 'WARN %s\\n' "$1" >&2; }
die()  { printf 'DIE %s\\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
CONTROLLER_URL="\${CONTROLLER_URL:-https://c.example.com}"
BAKED_RELEASE_PUBKEY_B64="\${BAKED_RELEASE_PUBKEY_B64:-}"
AGENT_IMAGE="\${AGENT_IMAGE:-ghcr.io/requestflo/swarmy-agent:latest}"
${RELEASE_VERIFY_SH}
${script}
`;
  writeFileSync(path.join(dir, 't.sh'), body);
  const p = Bun.spawnSync(['sh', path.join(dir, 't.sh')], {
    env: { PATH: `${dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, ...env },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('installer download integrity (H17)', () => {
  it('url_secure: https everywhere; plain http only for loopback or the explicit opt-in', () => {
    const r = run(
      `for u in https://c.example.com http://localhost:3021 http://127.0.0.1 'http://[::1]:3021' http://10.0.0.5:3021 http://127.0.0.1.evil.example ftp://x; do
  if url_secure "$u"; then echo "yes $u"; else echo "no $u"; fi
done`,
      {},
    );
    expect(r.out.trim().split('\n')).toEqual([
      'yes https://c.example.com',
      'yes http://localhost:3021',
      'yes http://127.0.0.1',
      'yes http://[::1]:3021',
      'no http://10.0.0.5:3021',
      'no http://127.0.0.1.evil.example',
      'no ftp://x',
    ]);
    const insecure = run('url_secure http://10.0.0.5:3021 && echo yes', {}, { SWARMY_ALLOW_INSECURE: '1' });
    expect(insecure.out.trim()).toBe('yes');
    const refused = run('require_secure_url http://10.0.0.5:3021 "The controller URL"', {});
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('must be an https:// address');
    const fetchRefused = run('fetch http://10.0.0.5:3021/install/bin/linux-x64 /dev/null', {});
    expect(fetchRefused.code).not.toBe(0);
    expect(fetchRefused.err).toContain('refusing to download over plain HTTP');
  });

  it('the installer threads the checks through every download', () => {
    const body = renderInstaller({
      controllerUrl: 'https://c.example.com',
      version: '1.2.0',
      agentImage: 'ghcr.io/requestflo/swarmy-agent:latest',
      binaryBaseUrl: 'https://c.example.com/install/bin',
      binarySha256: { 'linux-x64': SHA_X64 },
      releasePubkeyPem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
    });
    expect(body).toContain('require_secure_url "$CONTROLLER_URL" "The controller URL"');
    expect(body).toContain('load_release');
    expect(body).toContain('exp="$(pinned_binary_sha "$platform" "$(expected_sha "$platform")")" || exit 1');
    expect(body).toContain('fetch "$BINARY_BASE_URL/$platform" "$tmp"');
    expect(body).toContain('pin_agent_image');
    expect(body).toContain(`BAKED_RELEASE_PUBKEY_B64="${b64('-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n')}"`);
    // No raw `curl -fsSL "$BINARY_BASE_URL…` left: every agent download goes through fetch.
    expect(body).not.toMatch(/curl -fsSL "\$BINARY_BASE_URL/);
    const unkeyed = renderInstaller({ controllerUrl: 'https://c', version: '1.2.0', agentImage: 'i', binaryBaseUrl: 'https://c/b', binarySha256: {} });
    expect(unkeyed).toContain('BAKED_RELEASE_PUBKEY_B64=""');
  });

  it('no key configured: falls back to the controller checksum with a clear warning', () => {
    const k = keys();
    const body = canonicalManifestJson(manifest);
    const r = run('load_release; echo "state=$RELEASE_STATE"; pinned_binary_sha linux-x64 ' + 'f'.repeat(64), { manifest: body, sig: signPlatformManifest(manifest, k.priv) });
    expect(r.code).toBe(0);
    expect(r.out).toContain('state=unverified');
    expect(r.out).toContain('f'.repeat(64));
    expect(r.err).toContain('UNVERIFIED RELEASE: no swarmy release key is configured');
  });

  it('no signed manifest on the controller: fallback + warning; but an explicit operator key refuses', () => {
    const r = run('load_release; echo "state=$RELEASE_STATE"', {});
    expect(r.code).toBe(0);
    expect(r.out).toContain('state=none');
    expect(r.err).toContain('no signed release manifest for this build');
    const strict = run('load_release', {}, { SWARMY_RELEASE_PUBKEY: keys().pub });
    expect(strict.code).not.toBe(0);
    expect(strict.err).toContain('SWARMY_RELEASE_PUBKEY is set');
  });

  it.skipIf(!HAS_OPENSSL)('a verified manifest pins the agent binary and the agent image digest', () => {
    const k = keys();
    const served = { manifest: canonicalManifestJson(manifest), sig: signPlatformManifest(manifest, k.priv) };
    // Baked key (what the controller puts in the installer).
    const r = run(
      `load_release; echo "state=$RELEASE_STATE"; echo "bin=$(pinned_binary_sha linux-x64 ${SHA_X64})"; echo "none=$(release_binary_sha linux-arm64)"; pin_agent_image; echo "img=$AGENT_IMAGE"`,
      served,
      { BAKED_RELEASE_PUBKEY_B64: b64(k.pub) },
    );
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('state=verified');
    expect(r.out).toContain(`bin=${SHA_X64}`);
    expect(r.out).toContain('none=\n');
    expect(r.out).toContain(`img=ghcr.io/requestflo/swarmy-agent@${AGENT_DIGEST}`);
    // The operator's own key (PEM in env) works the same.
    const own = run('load_release; echo "state=$RELEASE_STATE"', served, { SWARMY_RELEASE_PUBKEY: k.pub });
    expect(own.out).toContain('state=verified');
  });

  it.skipIf(!HAS_OPENSSL)('a controller pin that contradicts the signed release is fatal', () => {
    const k = keys();
    const served = { manifest: canonicalManifestJson(manifest), sig: signPlatformManifest(manifest, k.priv) };
    const r = run(`load_release; x="$(pinned_binary_sha linux-x64 ${'b'.repeat(64)})" || exit 1; echo "x=$x"`, served, { BAKED_RELEASE_PUBKEY_B64: b64(k.pub) });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('different agent binary');
    expect(r.out).not.toContain('x=');
  });

  it.skipIf(!HAS_OPENSSL)('a tampered manifest, a wrong key or a garbage signature refuses to install', () => {
    const k = keys();
    const sig = signPlatformManifest(manifest, k.priv);
    const tampered = canonicalManifestJson(manifest).replace(SHA_X64, 'c'.repeat(64));
    const t = run('load_release', { manifest: tampered, sig }, { BAKED_RELEASE_PUBKEY_B64: b64(k.pub) });
    expect(t.code).not.toBe(0);
    expect(t.err).toContain('does NOT match the swarmy release key');
    const wrong = run('load_release', { manifest: canonicalManifestJson(manifest), sig }, { BAKED_RELEASE_PUBKEY_B64: b64(keys().pub) });
    expect(wrong.code).not.toBe(0);
    const garbage = run('load_release', { manifest: canonicalManifestJson(manifest), sig: '!!!' }, { BAKED_RELEASE_PUBKEY_B64: b64(k.pub) });
    expect(garbage.code).not.toBe(0);
  });

  it.skipIf(!HAS_OPENSSL)('Ed25519 release keys verify too', () => {
    const k = keys('ed25519');
    const served = { manifest: canonicalManifestJson(manifest), sig: signPlatformManifest(manifest, k.priv) };
    const r = run('load_release; echo "state=$RELEASE_STATE"', served, { SWARMY_RELEASE_PUBKEY: k.pub });
    expect(r.out).toContain('state=verified');
  });

  it.skipIf(!HAS_OPENSSL)('agent image pinning: a custom image warns, a contradicting digest is fatal', () => {
    const k = keys();
    const served = { manifest: canonicalManifestJson(manifest), sig: signPlatformManifest(manifest, k.priv) };
    const env = { BAKED_RELEASE_PUBKEY_B64: b64(k.pub) };
    const custom = run('load_release; pin_agent_image; echo "img=$AGENT_IMAGE"', served, { ...env, AGENT_IMAGE: '10.0.0.5:5000/swarmy-agent:1.2.0' });
    expect(custom.out).toContain('img=10.0.0.5:5000/swarmy-agent:1.2.0');
    expect(custom.err).toContain('not the one in the signed release');
    const bad = run('load_release; pin_agent_image', served, { ...env, AGENT_IMAGE: `ghcr.io/requestflo/swarmy-agent@sha256:${'0'.repeat(64)}` });
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('different digest');
  });

  it('image_repo strips tag and digest, keeps a registry port', () => {
    const r = run(
      'image_repo ghcr.io/a/b:1; image_repo "ghcr.io/a/b@sha256:abc"; image_repo 10.0.0.5:5000/x; image_repo 10.0.0.5:5000/x:tag',
      {},
    );
    expect(r.out.trim().split('\n')).toEqual(['ghcr.io/a/b', 'ghcr.io/a/b', '10.0.0.5:5000/x', '10.0.0.5:5000/x']);
  });
});
