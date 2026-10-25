import { describe, expect, it } from 'bun:test';
import { buildPlatformManifest, parsePlatformManifest } from './platform-manifest';
import { DATA_IMAGES, dataImageFor } from './data-images';
import { planBundle } from './platform-bundle-plan';
import { registryForwarderImage } from './registry-forwarder';
import { SYSTEM_IMAGES, pinnedTaggedRef, type SystemImageKey } from './system-images';

const d = (c: string) => `sha256:${c.repeat(64)}`;
const FLOATING = SYSTEM_IMAGES.filter((i) => !i.digest).map((i) => i.key);

/** The manifest CI publishes: the BOM with a digest for every own build. */
function release(over: Partial<Record<SystemImageKey, string>> = {}) {
  const digests = Object.fromEntries(FLOATING.map((k) => [k, d('a')])) as Partial<Record<SystemImageKey, string>>;
  return buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'c', tag: '1.3.0', digests: { ...digests, ...over } });
}

describe('planBundle — the offline bundle covers the BOM (nothing a node pulls is missed)', () => {
  it('carries every BOM image at the release digest', () => {
    const plan = planBundle(release());
    expect(plan.unresolved).toEqual([]);
    expect(plan.notInRelease).toEqual([]);
    expect(plan.omitted).toEqual([]);
    expect(plan.images.map((i) => i.key).sort()).toEqual(SYSTEM_IMAGES.map((i) => i.key).sort());
    for (const img of SYSTEM_IMAGES) {
      const got = plan.images.find((i) => i.key === img.key)!;
      expect(got.ref).toBe(img.ref);
      expect(got.digest).toBe(img.digest ?? d('a'));
      expect(got.source.endsWith(`@${got.digest}`)).toBe(true);
    }
  });

  it('includes what a joining node pulls first: the forwarder Caddy and the NetBird images', () => {
    const plan = planBundle(release());
    const refs = plan.images.map((i) => `${i.ref}@${i.digest}`);
    expect(refs).toContain(registryForwarderImage());
    for (const k of ['netbirdClient', 'netbirdRelay', 'netbirdServer'] as const) expect(refs).toContain(pinnedTaggedRef(k));
  });

  it('copies by the repository the release published (a fork), never a floating tag', () => {
    const m = buildPlatformManifest({
      version: '1.3.0', channel: 'stable', commit: 'c', tag: '1.3.0',
      digests: Object.fromEntries(FLOATING.map((k) => [k, d('b')])),
      images: { controller: '10.0.0.5:5000/swarmy-controller' },
    });
    expect(planBundle(m).images.find((i) => i.key === 'controller')!.source).toBe(`10.0.0.5:5000/swarmy-controller@${d('b')}`);
    expect(planBundle(m).images.every((i) => /@sha256:[a-f0-9]{64}$/.test(i.source))).toBe(true);
  });

  it('reports an own build the release names without a digest (the script refuses)', () => {
    const digests = Object.fromEntries(FLOATING.filter((k) => k !== 'walg').map((k) => [k, d('a')]));
    const plan = planBundle(buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'c', digests }));
    expect(plan.unresolved).toEqual(['walg']);
    expect(plan.images.some((i) => i.key === 'walg')).toBe(false);
  });

  it('an older release: skips own builds it never names, still carries every pin', () => {
    const m = release();
    const { walg: _w, caddy: _c, ...components } = m.components;
    const plan = planBundle(parsePlatformManifest({ ...m, components }));
    expect(plan.notInRelease).toEqual(['walg']);
    expect(plan.images.find((i) => i.key === 'caddy')?.digest).toBe(SYSTEM_IMAGES.find((i) => i.key === 'caddy')!.digest!);
  });

  it('a newer release: carries components this BOM does not know yet', () => {
    const m = release();
    const plan = planBundle(parsePlatformManifest({
      ...m,
      components: { ...m.components, future: { ref: 'ghcr.io/x/future:1', image: 'ghcr.io/x/future', digest: d('c') } },
    }));
    expect(plan.images.find((i) => i.key === 'future')).toEqual({ key: 'future', ref: 'ghcr.io/x/future:1', source: `ghcr.io/x/future@${d('c')}`, digest: d('c') });
  });

  it('carries every managed-data image (engines at every offered major, backup and move helpers) at the release digest', () => {
    const plan = planBundle(release());
    for (const img of DATA_IMAGES) {
      const got = plan.images.find((i) => i.key === img.key);
      expect(got).toMatchObject({ ref: img.ref, digest: img.digest ?? d('a') });
    }
    for (const major of ['14', '15', '16', '17']) expect(plan.images.map((i) => i.ref)).toContain(dataImageFor('postgres', major)!.ref);
    // An upstream engine keeps its upstream tag in the release (not the release's own tag).
    expect(release().components.redis).toMatchObject({ ref: 'redis:7.4', tag: '7.4', digest: d('a') });
  });

  it('refuses a release that names a data image without its digest (an air-gapped node would pull it)', () => {
    const digests = Object.fromEntries(FLOATING.filter((k) => k !== 'postgres17').map((k) => [k, d('a')]));
    const plan = planBundle(buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'c', digests }));
    expect(plan.unresolved).toEqual(['postgres17']);
  });

  it('--without data-images leaves out exactly the data section, still every platform image', () => {
    const plan = planBundle(release(), SYSTEM_IMAGES, { without: ['data-images'] });
    expect(plan.unresolved).toEqual([]);
    expect(plan.omitted.sort()).toEqual(DATA_IMAGES.map((i) => i.key).sort());
    expect(plan.images.map((i) => i.key).sort()).toEqual(SYSTEM_IMAGES.filter((i) => !DATA_IMAGES.includes(i as never)).map((i) => i.key).sort());
    // Even a data image the release names without a digest is no reason to refuse then.
    const digests = Object.fromEntries(FLOATING.filter((k) => k !== 'redis').map((k) => [k, d('a')]));
    const m = buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'c', digests });
    expect(planBundle(m, SYSTEM_IMAGES, { without: ['data-images'] }).unresolved).toEqual([]);
  });
});
