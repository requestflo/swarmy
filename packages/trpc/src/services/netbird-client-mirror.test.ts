import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NETBIRD_CLIENT_DOWNLOADS, NETBIRD_CLIENT_DOWNLOAD_VERSION } from '@swarmy/mesh';
import { connectDownloads, mirrorBaseFor, mirroredCliAssets, netbirdClientFilePath, netbirdClientMirror, resetNetbirdClientMirrorCache } from './netbird-client-mirror';

const [MAC, WIN] = NETBIRD_CLIENT_DOWNLOADS;
let dir = '';
const prev = process.env.SWARMY_NETBIRD_CLIENT_DIR;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'nb-mirror-'));
  process.env.SWARMY_NETBIRD_CLIENT_DIR = dir;
  resetNetbirdClientMirrorCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prev === undefined) delete process.env.SWARMY_NETBIRD_CLIENT_DIR;
  else process.env.SWARMY_NETBIRD_CLIENT_DIR = prev;
  resetNetbirdClientMirrorCache();
});

describe('the controller NetBird client mirror', () => {
  it('no directory / no manifest → no mirror (links go upstream)', () => {
    expect(netbirdClientMirror()).toBeNull();
    expect(netbirdClientFilePath(MAC!.file)).toBeNull();
  });

  it('an opted-out build (empty manifest) is no mirror', () => {
    writeFileSync(path.join(dir, 'manifest.json'), '{"version":"","files":{}}');
    expect(netbirdClientMirror()).toBeNull();
  });

  it('serves only files the manifest lists, that match the pins, and that exist', () => {
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        version: NETBIRD_CLIENT_DOWNLOAD_VERSION,
        files: { [MAC!.file]: { sha256: MAC!.sha256, size: MAC!.size }, [WIN!.file]: { sha256: WIN!.sha256, size: WIN!.size } },
      }),
    );
    writeFileSync(path.join(dir, MAC!.file), 'pkg');
    writeFileSync(path.join(dir, 'manifest.json.bak'), 'x');
    expect(Object.keys(netbirdClientMirror()!.files).sort()).toEqual([MAC!.file, WIN!.file].sort());
    expect(netbirdClientFilePath(MAC!.file)).toBe(path.join(dir, MAC!.file));
    expect(netbirdClientFilePath(WIN!.file)).toBeNull(); // listed, but not on disk
    expect(netbirdClientFilePath('manifest.json.bak')).toBeNull();
    expect(netbirdClientFilePath(`../${MAC!.file}`)).toBeNull();
  });
});

describe('connect-from-your-laptop download links', () => {
  const writeMac = () => {
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ version: NETBIRD_CLIENT_DOWNLOAD_VERSION, files: { [MAC!.file]: { sha256: MAC!.sha256, size: MAC!.size } } }),
    );
    writeFileSync(path.join(dir, MAC!.file), 'pkg');
  };

  it('mirror links only where the install surface serves them (H17: https, or the opt-in)', () => {
    expect(mirrorBaseFor('https://swarmy.example.com/', {})).toBe('https://swarmy.example.com');
    expect(mirrorBaseFor('http://10.0.0.5:3021', {})).toBeNull();
    expect(mirrorBaseFor('http://10.0.0.5:3021', { SWARMY_ALLOW_INSECURE_INSTALL: 'true' })).toBe('http://10.0.0.5:3021');
  });

  it('https controller → its own copy; plain http → upstream', () => {
    writeMac();
    const https = connectDownloads('https://swarmy.example.com').find((l) => l.platform === MAC!.platform)!;
    expect(https).toMatchObject({ mirrored: true, url: `https://swarmy.example.com/install/netbird/${MAC!.file}` });
    const prevInsecure = process.env.SWARMY_ALLOW_INSECURE_INSTALL;
    process.env.SWARMY_ALLOW_INSECURE_INSTALL = '0';
    try {
      const http = connectDownloads('http://10.0.0.5:3021').find((l) => l.platform === MAC!.platform)!;
      expect(http.mirrored).toBe(false);
      expect(http.url).toContain('/releases/download/v');
    } finally {
      if (prevInsecure === undefined) delete process.env.SWARMY_ALLOW_INSECURE_INSTALL;
      else process.env.SWARMY_ALLOW_INSECURE_INSTALL = prevInsecure;
    }
  });

  it('the CLI installer offers only mirrored Linux/macOS files', () => {
    writeMac();
    expect(mirroredCliAssets()).toEqual([{ platform: MAC!.platform, file: MAC!.file, sha256: MAC!.sha256 }]);
    expect(mirroredCliAssets(null)).toEqual([]);
  });
});
