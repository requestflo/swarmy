import { describe, expect, test } from 'bun:test';
import { BUNDLED_GEOIP_PATH, geoipCandidatePaths, locateRecord } from './geoip-fallback';

const base = { downloadedPath: '/data/geoip/city.mmdb', operatorFile: undefined, bundledPath: BUNDLED_GEOIP_PATH };

describe('geoipCandidatePaths', () => {
  test('dbip/maxmind: the downloaded copy first, the bundled copy as the floor', () => {
    expect(geoipCandidatePaths({ ...base, source: 'dbip' })).toEqual(['/data/geoip/city.mmdb', BUNDLED_GEOIP_PATH]);
    expect(geoipCandidatePaths({ ...base, source: 'maxmind' })).toEqual(['/data/geoip/city.mmdb', BUNDLED_GEOIP_PATH]);
  });

  test('file: the operator file first, then bundled; unset file → bundled only', () => {
    expect(geoipCandidatePaths({ ...base, source: 'file', operatorFile: '/geo/own.mmdb' })).toEqual([
      '/geo/own.mmdb',
      BUNDLED_GEOIP_PATH,
    ]);
    expect(geoipCandidatePaths({ ...base, source: 'file' })).toEqual([BUNDLED_GEOIP_PATH]);
  });

  test('off: nothing, not even the bundled copy', () => {
    expect(geoipCandidatePaths({ ...base, source: 'off' })).toEqual([]);
  });

  test('bundled fallback disabled → only the primary; duplicates collapse', () => {
    expect(geoipCandidatePaths({ ...base, source: 'dbip', bundledPath: undefined })).toEqual(['/data/geoip/city.mmdb']);
    expect(
      geoipCandidatePaths({ ...base, source: 'file', operatorFile: BUNDLED_GEOIP_PATH }),
    ).toEqual([BUNDLED_GEOIP_PATH]);
  });
});

describe('locateRecord', () => {
  test('city edition: exact location wins', () => {
    expect(
      locateRecord({ location: { latitude: 1.5, longitude: 2.5 }, country: { iso_code: 'US' } }),
    ).toEqual({ lat: 1.5, lon: 2.5 });
  });

  test('country edition: representative point for the country', () => {
    expect(locateRecord({ country: { iso_code: 'DE' }, continent: { code: 'EU' } })).toEqual({ lat: 50.1, lon: 8.7 });
    expect(locateRecord({ registered_country: { iso_code: 'sg' } })).toEqual({ lat: 1.3, lon: 103.8 });
  });

  test('unknown country → continent point; nothing usable → undefined', () => {
    expect(locateRecord({ country: { iso_code: 'ZZ' }, continent: { code: 'SA' } })).toEqual({ lat: -15.0, lon: -60.0 });
    expect(locateRecord({})).toBeUndefined();
    expect(locateRecord(null)).toBeUndefined();
  });
});
