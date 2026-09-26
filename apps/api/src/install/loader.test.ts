import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderLoader, renderChecksumFile, sha256Hex } from './loader';
import { renderInstaller } from './installer';

const CONTROLLER = 'https://app.swarmy.dev';
const VERSION = '1.2.3';

function installer(): string {
  return renderInstaller({
    controllerUrl: CONTROLLER,
    version: VERSION,
    agentImage: 'ghcr.io/swarmy/agent:1.2.3',
    binaryBaseUrl: `${CONTROLLER}/install/${VERSION}/agent`,
    binarySha256: { 'linux-x64': 'a'.repeat(64), 'linux-arm64': 'b'.repeat(64) },
  });
}

describe('sha256Hex', () => {
  it('matches node crypto for a known string', () => {
    const expected = createHash('sha256').update('hello', 'utf8').digest('hex');
    expect(sha256Hex('hello')).toBe(expected);
  });
});

describe('renderChecksumFile', () => {
  it('emits `<hex>  install.sh` matching the body hash', () => {
    const body = installer();
    const line = renderChecksumFile(body);
    expect(line).toBe(`${sha256Hex(body)}  install.sh\n`);
    // Format must be sha256sum-compatible (`<64 hex>  install.sh`).
    expect(line).toMatch(/^[0-9a-f]{64} {2}install\.sh\n$/);
  });
});

describe('renderLoader', () => {
  it('pins the installer URL + checksum the loader will verify', () => {
    const body = installer();
    const sha = sha256Hex(body);
    const loader = renderLoader({ controllerUrl: CONTROLLER, version: VERSION, installerSha256: sha });
    expect(loader).toContain(`${CONTROLLER}/install/${VERSION}/install.sh`);
    expect(loader).toContain(sha);
    expect(loader.startsWith('#!/usr/bin/env sh')).toBe(true);
  });

  it('the loader is tiny and reviewable (well under the installer size)', () => {
    const body = installer();
    const loader = renderLoader({ controllerUrl: CONTROLLER, version: VERSION, installerSha256: sha256Hex(body) });
    expect(loader.length).toBeLessThan(body.length);
    expect(loader.length).toBeLessThan(6_000);
  });

  it('verifies the checksum and fails loudly on mismatch (script invariants)', () => {
    const loader = renderLoader({ controllerUrl: CONTROLLER, version: VERSION, installerSha256: 'c'.repeat(64) });
    expect(loader).toContain('checksum mismatch');
    expect(loader).toContain('set -eu');
    // exits non-zero via err() before exec'ing the body.
    expect(loader).toContain('exit 1');
  });

  it('lowercases the pinned checksum', () => {
    const loader = renderLoader({ controllerUrl: CONTROLLER, version: VERSION, installerSha256: 'ABCDEF'.padEnd(64, '0') });
    expect(loader).toContain('abcdef'.padEnd(64, '0'));
    expect(loader).not.toContain('ABCDEF');
  });
});

describe('loader ↔ checksum-file round trip', () => {
  it('the checksum the loader pins equals the checksum file the route serves', () => {
    const body = installer();
    const fileSha = renderChecksumFile(body).split(' ')[0] ?? '';
    const loader = renderLoader({ controllerUrl: CONTROLLER, version: VERSION, installerSha256: fileSha });
    expect(loader).toContain(fileSha);
  });
});

/**
 * Run a rendered loader under a real `sh` with a fake `curl` on PATH that
 * records every URL it's asked for and serves a stub "installer" which dumps
 * the env it inherited. Proves the whole chain derives from ONE base.
 */
function runLoader(
  loaderBody: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number; stderr: string; curlUrls: string[]; curlFlags: string[]; installerEnv: Record<string, string>; installerArgs: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-loader-'));
  const stub = `#!/bin/sh\nprintf 'CTL=%s\\nBIN=%s\\nTOK=%s\\n' "$SWARMY_CONTROLLER_URL" "$SWARMY_BINARY_BASE_URL" "\${SWARMY_JOIN_TOKEN:-}" > "${dir}/env.out"\nprintf '%s ' "$@" > "${dir}/args.out"\n`;
  writeFileSync(path.join(dir, 'installer.sh'), stub);
  writeFileSync(
    path.join(dir, 'curl'),
    `#!/bin/sh\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --proto|--proto-redir) echo "$1 $2" >> "${dir}/curl.flags"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done\necho "$url" >> "${dir}/curl.log"\ncp "${dir}/installer.sh" "$out"\n`,
  );
  chmodSync(path.join(dir, 'curl'), 0o755);
  writeFileSync(path.join(dir, 'loader.sh'), loaderBody);
  const proc = Bun.spawnSync(['sh', path.join(dir, 'loader.sh'), ...args], {
    env: {
      PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      SWARMY_INSTALLER_SHA256: sha256Hex(stub),
      ...env,
    },
  });
  const read = (f: string): string => {
    try {
      return readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return '';
    }
  };
  const installerEnv = Object.fromEntries(
    read('env.out')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return {
    status: proc.exitCode ?? -1,
    stderr: proc.stderr.toString(),
    curlUrls: read('curl.log').split('\n').filter(Boolean),
    curlFlags: read('curl.flags').split('\n').filter(Boolean),
    installerEnv,
    installerArgs: read('args.out').trim(),
  };
}

describe('loader: one controller base drives every stage', () => {
  // The controller baked its (unreachable) localhost default; the node reached
  // it at a LAN address — the exact readiness-sweep failure.
  const loader = renderLoader({ controllerUrl: 'http://localhost:3021', version: VERSION, installerSha256: 'f'.repeat(64) });
  const LAN = 'https://swarmy.lan:3021';

  it('--controller <base> → installer URL, binary base, and dial-back all use that base', () => {
    const r = runLoader(loader, ['--controller', LAN, '--uninstall'], { SWARMY_JOIN_TOKEN: 'swt_x' });
    expect(r.status).toBe(0);
    expect(r.curlUrls).toEqual([`${LAN}/install/${VERSION}/install.sh`]);
    expect(r.installerEnv).toEqual({ CTL: LAN, BIN: `${LAN}/install/bin`, TOK: 'swt_x' });
    // Loader-only flags are consumed; the rest are forwarded to the installer.
    expect(r.installerArgs).toBe('--uninstall');
  }, 30_000);

  it('--controller=<base>/ and --token work (trailing slash trimmed)', () => {
    const r = runLoader(loader, [`--controller=${LAN}/`, '--token', 'swt_arg']);
    expect(r.status).toBe(0);
    expect(r.installerEnv.CTL).toBe(LAN);
    expect(r.installerEnv.TOK).toBe('swt_arg');
  }, 30_000);

  it('SWARMY_CONTROLLER_URL env works like --controller', () => {
    const r = runLoader(loader, [], { SWARMY_CONTROLLER_URL: LAN });
    expect(r.curlUrls[0]).toBe(`${LAN}/install/${VERSION}/install.sh`);
    expect(r.installerEnv.BIN).toBe(`${LAN}/install/bin`);
  }, 30_000);

  it('with no override, the baked (request-resolved) base is used — and loopback warns', () => {
    const r = runLoader(loader, []);
    expect(r.curlUrls[0]).toBe(`http://localhost:3021/install/${VERSION}/install.sh`);
    expect(r.stderr).toContain('loopback');
  }, 30_000);

  it('an operator-pinned binary CDN is kept', () => {
    const cdn = renderLoader({
      controllerUrl: LAN,
      version: VERSION,
      installerSha256: 'f'.repeat(64),
      binaryBaseUrl: 'https://cdn.example.com/agent',
    });
    const r = runLoader(cdn, []);
    expect(r.installerEnv).toMatchObject({ CTL: LAN, BIN: 'https://cdn.example.com/agent' });
  }, 30_000);

  it('rejects a non-http controller and a dangling --controller', () => {
    expect(runLoader(loader, ['--controller', 'ftp://x']).status).not.toBe(0);
    expect(runLoader(loader, ['--controller']).status).not.toBe(0);
  }, 30_000);

  it('checksum mismatch still refuses to run the installer', () => {
    const r = runLoader(loader, ['--controller', LAN], { SWARMY_INSTALLER_SHA256: '0'.repeat(64) });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('checksum mismatch');
    expect(r.installerEnv).toEqual({});
  }, 30_000);

  it('a quote in the baked default cannot break out of the script', () => {
    const evil = renderLoader({ controllerUrl: "https://x/'; touch /tmp/pwned; '", version: VERSION, installerSha256: 'f'.repeat(64) });
    const r = runLoader(evil, []);
    // The value is treated as data (and then rejected/used verbatim) — never executed.
    expect(r.curlUrls[0] ?? '').toContain("'; touch /tmp/pwned; '");
  }, 30_000);
});

describe('loader: HTTPS only (H17)', () => {
  const HTTP_LAN = 'http://192.168.11.87:3021';
  const secure = renderLoader({ controllerUrl: 'https://app.example.com', version: VERSION, installerSha256: 'f'.repeat(64) });

  it('refuses a plain-HTTP controller and names the HTTPS address', () => {
    const r = runLoader(secure, ['--controller', HTTP_LAN]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('must be https://');
    expect(r.stderr).toContain('(https://app.example.com)');
    expect(r.curlUrls).toEqual([]);
  }, 30_000);

  it('pins curl to https for the download and every redirect', () => {
    const r = runLoader(secure, []);
    expect(r.status).toBe(0);
    expect(r.curlFlags).toEqual(['--proto =https', '--proto-redir =https']);
  }, 30_000);

  it('the node-local bootstrap (loopback) may use plain HTTP', () => {
    for (const url of ['http://localhost:3021', 'http://127.0.0.1:3021', 'http://[::1]:3021']) {
      const r = runLoader(secure, ['--controller', url]);
      expect(r.status).toBe(0);
      expect(r.curlUrls[0]).toBe(`${url}/install/${VERSION}/install.sh`);
    }
    // A DNS name that merely starts like loopback is not loopback.
    expect(runLoader(secure, ['--controller', 'http://127.0.0.1.evil.example:3021']).status).not.toBe(0);
    expect(runLoader(secure, ['--controller', 'http://localhost.evil.example']).status).not.toBe(0);
  }, 30_000);

  it('SWARMY_ALLOW_INSECURE=1 (or the controller operator\'s baked opt-in) allows it, loudly', () => {
    const r = runLoader(secure, ['--controller', HTTP_LAN], { SWARMY_ALLOW_INSECURE: '1' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('INSECURE');
    expect(r.curlFlags).toContain('--proto-redir =https');
    const optedIn = renderLoader({ controllerUrl: HTTP_LAN, version: VERSION, installerSha256: 'f'.repeat(64), allowInsecure: true });
    const r2 = runLoader(optedIn, []);
    expect(r2.status).toBe(0);
    expect(r2.stderr).toContain('INSECURE');
  }, 30_000);
});

describe('installer: parses cleanly and derives binaries from the resolved base', () => {
  const body = renderInstaller({
    controllerUrl: 'http://localhost:3021',
    version: VERSION,
    agentImage: 'img',
    binaryBaseUrl: 'http://localhost:3021/install/bin',
    binarySha256: { 'linux-x64': 'a'.repeat(64) },
    binaryBaseFromController: true,
  });

  it('is valid POSIX sh', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-inst-'));
    writeFileSync(path.join(dir, 'install.sh'), body);
    expect(Bun.spawnSync(['sh', '-n', path.join(dir, 'install.sh')]).exitCode).toBe(0);
  }, 30_000);

  it('re-derives BINARY_BASE_URL from CONTROLLER_URL unless explicitly pinned', () => {
    expect(body).toContain('[ -n "${SWARMY_BINARY_BASE_URL:-}" ] || BINARY_BASE_URL="$CONTROLLER_URL/install/bin"');
    const cdn = renderInstaller({
      controllerUrl: 'http://localhost:3021',
      version: VERSION,
      agentImage: 'img',
      binaryBaseUrl: 'https://cdn.example.com',
      binarySha256: {},
    });
    expect(cdn).not.toContain('BINARY_BASE_URL="$CONTROLLER_URL/install/bin"');
  });

  it('threads an explicit SWARMY_ALLOW_BUILD override into the agent env (never forces it)', () => {
    expect(body).toContain('ALLOW_BUILD="${SWARMY_ALLOW_BUILD:-}"');
    expect(body).toContain('[ -z "$ALLOW_BUILD" ] || echo "SWARMY_ALLOW_BUILD=$ALLOW_BUILD"');
  });

  it('initialises DROP_AGENT_STATE (set -u safe on the docker backend)', () => {
    expect(body).toContain('DROP_AGENT_STATE=""');
  });
});
