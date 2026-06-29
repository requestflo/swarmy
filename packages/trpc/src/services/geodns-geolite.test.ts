import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MMDB_PATH,
  GEOLITE_VOLUME,
  geoipEnabled,
  geoliteInitScript,
  parseGeoDnsSettings,
  resolveGeoLite,
} from './geodns-geolite';
import { renderCoreDns, type ZoneSnapshot } from './geodns.service';

const snap: ZoneSnapshot = {
  zone: 'geo.example.com',
  ttl: 30,
  provider: 'coredns',
  endpoints: [{ host: 'app.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: true }],
};

describe('resolveGeoLite', () => {
  it('config mount wins and enables geoip', () => {
    const plan = resolveGeoLite({ mmdbConfigRef: 'swarmy-geolite2' });
    expect(plan).toEqual({ mode: 'config', mmdbPath: DEFAULT_MMDB_PATH, configRef: 'swarmy-geolite2' });
    expect(geoipEnabled(plan)).toBe(true);
  });

  it('license init enables geoip via a per-node volume', () => {
    const plan = resolveGeoLite({ maxmindLicenseSecretRef: 'mm-key' });
    expect(plan.mode).toBe('license');
    if (plan.mode === 'license') expect(plan.volume).toBe(GEOLITE_VOLUME);
    expect(geoipEnabled(plan)).toBe(true);
  });

  it('degrades to none (geoip off) when nothing is configured', () => {
    const plan = resolveGeoLite(undefined);
    expect(plan.mode).toBe('none');
    expect(geoipEnabled(plan)).toBe(false);
  });

  it('config beats license when both are set', () => {
    expect(resolveGeoLite({ mmdbConfigRef: 'c', maxmindLicenseSecretRef: 's' }).mode).toBe('config');
  });
});

describe('parseGeoDnsSettings', () => {
  it('keeps only string reference fields and ignores junk', () => {
    expect(
      parseGeoDnsSettings({ mmdbConfigRef: 'c', providerZoneId: 'z', ttl: 5, nope: { x: 1 } }),
    ).toEqual({
      mmdbConfigRef: 'c',
      maxmindLicenseSecretRef: undefined,
      providerZoneId: 'z',
      providerTokenEnv: undefined,
      providerRegion: undefined,
    });
    expect(parseGeoDnsSettings(null)).toEqual({});
  });
});

describe('renderCoreDns graceful degrade', () => {
  const corefileOf = (opts?: Parameters<typeof renderCoreDns>[1]): string => {
    const file = renderCoreDns(snap, opts).files.find((f) => f.path.endsWith('Corefile'));
    return file?.contents ?? '';
  };

  it('includes geoip by default and at a custom path', () => {
    expect(corefileOf()).toContain('geoip /etc/coredns/GeoLite2-City.mmdb {');
    expect(corefileOf({ geoip: '/etc/coredns/geoip/GeoLite2-City.mmdb' })).toContain(
      'geoip /etc/coredns/geoip/GeoLite2-City.mmdb {',
    );
  });

  it('omits geoip (round-robin) when geoip:false, keeping loadbalance', () => {
    const corefile = corefileOf({ geoip: false });
    expect(corefile).not.toContain('geoip');
    expect(corefile).not.toContain('metadata');
    expect(corefile).toContain('loadbalance');
  });
});

describe('geoliteInitScript', () => {
  it('reads the license from the mounted secret and writes the mmdb to the volume dir', () => {
    const s = geoliteInitScript('mm-key', '/etc/coredns/geoip');
    expect(s).toContain('/run/secrets/mm-key');
    expect(s).toContain('/etc/coredns/geoip/GeoLite2-City.mmdb');
    expect(s).toContain('edition_id=GeoLite2-City');
  });
});
