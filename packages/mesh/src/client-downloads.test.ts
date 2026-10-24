import { describe, expect, it } from 'bun:test';
import {
  NETBIRD_CLIENT_DOWNLOADS,
  NETBIRD_CLIENT_DOWNLOAD_VERSION,
  clientDownloads,
  parseClientMirrorManifest,
  servableClientFile,
  upstreamClientUrl,
} from './client-downloads';
import { NETBIRD_CLIENT_REF } from './images';

const MAC = NETBIRD_CLIENT_DOWNLOADS.find((a) => a.platform === 'macos-arm64')!;
const LINUX = NETBIRD_CLIENT_DOWNLOADS.find((a) => a.platform === 'linux-amd64')!;
const manifest = (files: Record<string, { sha256: string; size: number }>) => ({ version: NETBIRD_CLIENT_DOWNLOAD_VERSION, files });

describe('NetBird client download mirror (epic §3.4, M3)', () => {
  it('pins the same release as the client image in the BOM (bump them together)', () => {
    expect(NETBIRD_CLIENT_REF.endsWith(`:${NETBIRD_CLIENT_DOWNLOAD_VERSION}`)).toBe(true);
    for (const a of NETBIRD_CLIENT_DOWNLOADS) {
      expect(a.file).toContain(`_${NETBIRD_CLIENT_DOWNLOAD_VERSION}_`);
      expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(a.size).toBeGreaterThan(1_000_000);
    }
    expect(new Set(NETBIRD_CLIENT_DOWNLOADS.map((a) => a.file)).size).toBe(NETBIRD_CLIENT_DOWNLOADS.length);
  });

  it('serves only exact listed file names: no traversal, no other files', () => {
    expect(servableClientFile(MAC.file)?.platform).toBe('macos-arm64');
    for (const bad of ['manifest.json', `../${MAC.file}`, `${MAC.file}/x`, '/etc/passwd', '', 'netbird_0.79.0_linux_386.tar.gz']) {
      expect(servableClientFile(bad)).toBeNull();
    }
  });

  it('a manifest is trusted only where it matches the pins', () => {
    const m = parseClientMirrorManifest(
      manifest({
        [MAC.file]: { sha256: MAC.sha256, size: MAC.size },
        [LINUX.file]: { sha256: '0'.repeat(64), size: LINUX.size }, // tampered
        'evil.sh': { sha256: MAC.sha256, size: 1 }, // not listed
      }),
    );
    expect(Object.keys(m!.files)).toEqual([MAC.file]);
    expect(parseClientMirrorManifest({ version: '0.1.0', files: {} })).toBeNull();
    expect(parseClientMirrorManifest('nope')).toBeNull();
    expect(parseClientMirrorManifest(null)).toBeNull();
  });

  it('links to the controller copy when mirrored, else upstream; phones go to the stores', () => {
    const links = clientDownloads(manifest({ [MAC.file]: { sha256: MAC.sha256, size: MAC.size } }), 'https://swarmy.example.com/');
    const mac = links.find((l) => l.platform === 'macos-arm64')!;
    expect(mac).toMatchObject({ mirrored: true, url: `https://swarmy.example.com/install/netbird/${MAC.file}`, sha256: MAC.sha256 });
    const linux = links.find((l) => l.platform === 'linux-amd64')!;
    expect(linux).toMatchObject({ mirrored: false, url: upstreamClientUrl(LINUX.file) });
    expect(linux.url).toBe(`https://github.com/netbirdio/netbird/releases/download/v0.79.0/${LINUX.file}`);
    expect(links.filter((l) => l.platform === 'ios' || l.platform === 'android').every((l) => !l.mirrored)).toBe(true);
  });

  it('with no manifest every desktop link is upstream (a build without egress still works)', () => {
    const links = clientDownloads(null, 'http://10.0.0.1:3021');
    expect(links.some((l) => l.mirrored)).toBe(false);
    expect(links).toHaveLength(NETBIRD_CLIENT_DOWNLOADS.length + 2);
  });
});
