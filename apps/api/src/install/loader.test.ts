import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
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
    expect(loader.length).toBeLessThan(2_500);
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
