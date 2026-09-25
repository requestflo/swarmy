import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildPlatformManifest,
  builtInManifest,
  canonicalJson,
  canonicalManifestJson,
  compareVersions,
  componentRef,
  describeWindow,
  inMaintenanceWindow,
  isPatchUpgrade,
  manifestImages,
  parsePlatformManifest,
  platformFeedUrl,
  upgradeBlockReason,
} from './platform-manifest';
import { signPlatformManifest, verifyPlatformManifest } from './platform-verify';
import { SYSTEM_IMAGES, type SystemImage } from './system-images';

const DC = `sha256:${'c'.repeat(64)}`;
const DA = `sha256:${'a'.repeat(64)}`;
const BOM: SystemImage[] = [
  { key: 'controller', ref: 'ghcr.io/requestflo/swarmy-controller:latest' },
  { key: 'registry', ref: 'registry:2', digest: DA },
];

describe('buildPlatformManifest (generated from the BOM, never a second list)', () => {
  test('covers every SYSTEM_IMAGES entry; pinned digests carried, own builds take CI digests', () => {
    const m = buildPlatformManifest({ version: '1.2.0', channel: 'stable', commit: 'abc', tag: '1.2.0', digests: { controller: DC } });
    expect(Object.keys(m.components).sort()).toEqual(SYSTEM_IMAGES.map((i) => i.key).sort());
    for (const img of SYSTEM_IMAGES) if (img.digest) expect(m.components[img.key]?.digest).toBe(img.digest);
    expect(m.components.controller).toEqual({
      ref: 'ghcr.io/requestflo/swarmy-controller:latest',
      image: 'ghcr.io/requestflo/swarmy-controller',
      tag: '1.2.0',
      digest: DC,
    });
    expect(m.components.dns?.digest).toBeUndefined(); // unresolved stays unresolved
    expect(componentRef(m, 'controller')).toBe(`ghcr.io/requestflo/swarmy-controller@${DC}`);
    expect(componentRef(m, 'dns')).toBeNull();
  });

  test('refuses a CI digest that contradicts a BOM pin, and malformed digests', () => {
    expect(() => buildPlatformManifest({ version: '1.0.0', channel: 'stable', commit: '', bom: BOM, digests: { registry: DC } })).toThrow(/pinned/);
    expect(() => buildPlatformManifest({ version: '1.0.0', channel: 'stable', commit: '', bom: BOM, digests: { controller: 'sha256:nope' } })).toThrow(/bad digest/);
  });

  test('image override (fork / e2e local registry) keeps the dispatch ref', () => {
    const m = buildPlatformManifest({
      version: '1.0.1', channel: 'edge', commit: 'x', bom: BOM, digests: { controller: DC }, images: { controller: '10.0.0.5:5000/swarmy-controller' },
    });
    expect(componentRef(m, 'controller')).toBe(`10.0.0.5:5000/swarmy-controller@${DC}`);
    expect(m.components.controller?.ref).toBe('ghcr.io/requestflo/swarmy-controller:latest');
  });

  test('manifestImages fills floating digests, keeps refs exact', () => {
    const m = buildPlatformManifest({ version: '1.2.0', channel: 'stable', commit: '', bom: BOM, digests: { controller: DC } });
    const imgs = manifestImages(m, BOM);
    expect(imgs.find((i) => i.key === 'controller')).toEqual({ key: 'controller', ref: BOM[0]!.ref, digest: DC });
    expect(imgs.find((i) => i.key === 'registry')?.digest).toBe(DA);
    expect(manifestImages(null, BOM)).toEqual(BOM);
  });

  test('builtInManifest is the "from" side of a first upgrade', () => {
    const m = builtInManifest('dev', 'abc', BOM);
    expect(m.version).toBe('0.0.0');
    expect(m.components.controller?.digest).toBeUndefined();
  });

  test('parse rejects bad shapes with a plain reason', () => {
    expect(() => parsePlatformManifest({ schema: 1, version: 'one', channel: 'stable', publishedAt: '', components: {} })).toThrow(/version/);
    expect(() => parsePlatformManifest('{"schema":2}')).toThrow(/invalid platform manifest/);
  });

  test('agentBinaries (H17): carried when CI passes them, absent otherwise — so older manifests keep their signed bytes', () => {
    const sha = 'e'.repeat(64);
    const m = buildPlatformManifest({
      version: '1.2.0', channel: 'stable', commit: 'abc', bom: BOM, publishedAt: '2026-09-25T00:00:00.000Z', agentBinaries: { 'linux-x64': sha.toUpperCase() },
    });
    expect(m.agentBinaries).toEqual({ 'linux-x64': { sha256: sha } });
    expect(canonicalManifestJson(m)).toContain(`"agentBinaries":{"linux-x64":{"sha256":"${sha}"}}`);
    const plain = buildPlatformManifest({ version: '1.2.0', channel: 'stable', commit: 'abc', bom: BOM, publishedAt: '2026-09-25T00:00:00.000Z' });
    expect('agentBinaries' in plain).toBe(false);
    expect(canonicalManifestJson(parsePlatformManifest(canonicalManifestJson(plain)))).toBe(canonicalManifestJson(plain));
    expect(() => parsePlatformManifest({ ...m, agentBinaries: { 'linux-x64': { sha256: 'nope' } } })).toThrow(/agentBinaries/);
  });

  test('canonical JSON sorts keys at every depth and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined, x: 0 }], c: 'q' } })).toBe('{"a":{"c":"q","d":[2,{"x":0,"z":1}]},"b":1}');
  });
});

describe('versions', () => {
  test('semver precedence incl. prereleases', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.2.1-edge.9', '1.2.1-edge.10')).toBeLessThan(0);
    expect(compareVersions('1.2.1-edge.50', '1.2.1')).toBeLessThan(0);
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('dev', '0.0.1')).toBeLessThan(0);
  });

  test('only a stable x.y.Z bump is a patch upgrade', () => {
    expect(isPatchUpgrade('1.2.3', '1.2.4')).toBe(true);
    expect(isPatchUpgrade('1.2.3', '1.3.0')).toBe(false);
    expect(isPatchUpgrade('1.2.3', '1.2.4-edge.1')).toBe(false);
    expect(isPatchUpgrade('1.2.4', '1.2.4')).toBe(false);
  });

  test('min-upgrade-from gates skipping releases', () => {
    const m = buildPlatformManifest({ version: '2.0.0', channel: 'stable', commit: '', bom: BOM, minUpgradeFrom: '1.5.0' });
    expect(upgradeBlockReason('1.4.0', m)).toMatch(/needs 1.5.0/);
    expect(upgradeBlockReason('1.5.0', m)).toBeNull();
    expect(upgradeBlockReason('2.0.0', m)).toMatch(/already on/);
  });
});

describe('feed + window', () => {
  test('feed URL precedence: setting → env → GitHub releases', () => {
    expect(platformFeedUrl('stable', null, {}).manifest).toBe('https://github.com/requestflo/swarmy/releases/download/stable/platform.json');
    expect(platformFeedUrl('edge', null, { SWARMY_PLATFORM_FEED_URL: 'https://mirror.lan/swarmy/' }).signature).toBe(
      'https://mirror.lan/swarmy/edge/platform.json.sig',
    );
    expect(platformFeedUrl('edge', 'https://org.example', { SWARMY_PLATFORM_FEED_URL: 'https://x' }).base).toBe('https://org.example');
  });

  test('maintenance window, including one that spills past midnight', () => {
    const w = { days: [0], startHour: 23, hours: 3 }; // Sun 23:00 → Mon 02:00
    expect(inMaintenanceWindow(w, new Date('2026-09-27T23:30:00Z'))).toBe(true); // Sun
    expect(inMaintenanceWindow(w, new Date('2026-09-28T01:59:00Z'))).toBe(true); // Mon
    expect(inMaintenanceWindow(w, new Date('2026-09-28T02:00:00Z'))).toBe(false);
    expect(inMaintenanceWindow(w, new Date('2026-09-27T22:59:00Z'))).toBe(false);
    expect(describeWindow({ days: [3, 0], startHour: 2, hours: 2 })).toBe('Sun, Wed 02:00–04:00 UTC');
  });
});

// A real `cosign sign-blob --key cosign.key --tlog-upload=false` signature
// (cosign v2.4.1) over the canonical bytes below: node:crypto must accept it.
const COSIGN_PUB = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE4y77xTHVB05VUhZmXu2LPgVJ48By
zr2Lbw/i8rid8mqQ+7/Hr/WZD2trII9Mq2dX5VTJviZX2mB6nBsOgzvJzQ==
-----END PUBLIC KEY-----`;
const COSIGN_SIG = 'MEQCIFTwAI7onxWTG0pnVJBjJ1rfglqkuYW1YPmjw8mqN7zVAiAdVy2IFztW4nELG0eDjre6UznhEjMoNNQZX692wIpt6g==';
const COSIGN_BLOB = buildPlatformManifest({
  version: '1.2.0',
  channel: 'stable',
  commit: 'abc1234',
  publishedAt: '2026-09-24T00:00:00.000Z',
  digests: { controller: DC },
  bom: BOM,
});

describe('verifyPlatformManifest (offline, swarmy release key)', () => {
  test('accepts a real cosign key-pair signature — raw bytes and the DB-stored object', () => {
    expect(verifyPlatformManifest(canonicalManifestJson(COSIGN_BLOB), COSIGN_SIG, COSIGN_PUB).ok).toBe(true);
    expect(verifyPlatformManifest(JSON.parse(JSON.stringify(COSIGN_BLOB)), COSIGN_SIG, COSIGN_PUB).ok).toBe(true);
  });

  test('a tampered manifest, a foreign key, no key, no signature → never verified', () => {
    const tampered = { ...COSIGN_BLOB, components: { ...COSIGN_BLOB.components, controller: { ...COSIGN_BLOB.components.controller!, digest: DA } } };
    expect(verifyPlatformManifest(tampered, COSIGN_SIG, COSIGN_PUB)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not match/) });
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyPlatformManifest(COSIGN_BLOB, COSIGN_SIG, other).ok).toBe(false);
    expect(verifyPlatformManifest(COSIGN_BLOB, COSIGN_SIG, null)).toMatchObject({ ok: false, reason: expect.stringMatching(/no swarmy release key/) });
    expect(verifyPlatformManifest(COSIGN_BLOB, '', COSIGN_PUB)).toMatchObject({ ok: false, reason: expect.stringMatching(/no signature/) });
    expect(verifyPlatformManifest({ schema: 9 }, COSIGN_SIG, COSIGN_PUB).ok).toBe(false);
  });

  test('signPlatformManifest (self-builders, e2e) round-trips for EC and Ed25519 keys', () => {
    for (const kp of [generateKeyPairSync('ec', { namedCurve: 'P-256' }), generateKeyPairSync('ed25519')]) {
      const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const sig = signPlatformManifest(COSIGN_BLOB, priv);
      expect(verifyPlatformManifest(COSIGN_BLOB, sig, pub).ok).toBe(true);
    }
  });
});
