import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderNetbirdInstaller } from './netbird-clients';

const LINUX = { platform: 'linux-amd64', file: 'netbird_0.79.0_linux_amd64.tar.gz', sha256: 'a'.repeat(64) };
const MAC = { platform: 'macos-arm64', file: 'netbird_0.79.0_darwin_arm64.pkg', sha256: 'b'.repeat(64) };
const WIN = { platform: 'windows-amd64', file: 'netbird_installer_0.79.0_windows_amd64.exe', sha256: 'c'.repeat(64) };

const bin = mkdtempSync(path.join(tmpdir(), 'nb-sh-'));
afterAll(() => rmSync(bin, { recursive: true, force: true }));

/** Run the script with `uname`/`curl`/`id` stubbed: a Linux x86_64 box whose download is junk. */
function runAsLinux(script: string) {
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  stub('uname', 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac');
  stub('id', 'echo 0');
  // curl -fsSL URL -o FILE → write junk to FILE (the checksum must catch it).
  stub('curl', 'while [ $# -gt 0 ]; do [ "$1" = -o ] && { echo junk > "$2"; exit 0; }; shift; done; exit 0');
  return Bun.spawnSync(['sh', '-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` } });
}

describe('/install/netbird.sh (the CLI installer served by the controller)', () => {
  it('pins each mirrored Linux/macOS file to its sha256, from this controller only', () => {
    const s = renderNetbirdInstaller('https://swarmy.example.com/', [LINUX, MAC, WIN]);
    expect(s).toContain("BASE='https://swarmy.example.com'");
    expect(s).toContain(`linux-amd64) file='${LINUX.file}'; want='${LINUX.sha256}' ;;`);
    expect(s).toContain(`macos-arm64) file='${MAC.file}'; want='${MAC.sha256}' ;;`);
    expect(s).not.toContain(WIN.file); // Windows uses the .exe from the Access tab
    expect(s).not.toContain('github.com');
    expect(Bun.spawnSync(['sh', '-n', '-c', s]).exitCode).toBe(0);
  });

  it('refuses a download whose checksum does not match', () => {
    const r = runAsLinux(renderNetbirdInstaller('https://swarmy.example.com', [LINUX]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('checksum mismatch');
  });

  it('says so when this controller mirrors nothing for the platform', () => {
    const r = runAsLinux(renderNetbirdInstaller('https://swarmy.example.com', []));
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('no mirrored client for linux-amd64');
  });
});
