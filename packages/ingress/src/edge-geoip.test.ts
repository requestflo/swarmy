import { describe, expect, it } from 'bun:test';
import { EDGE_GEOIP_BUNDLED_PATH, readEdgeGeoipSetting, resolveEdgeGeoip } from './edge-geoip';
import { buildCaddyfile } from './render/caddyfile';
import { IngressConfigSchema } from './types';
import { SWARMY_CADDY_IMAGE } from './drivers/caddy';

const STOCK = 'caddy:2-alpine';

describe('resolveEdgeGeoip — which country database the edge reads', () => {
  it('defaults to the bundled DB-IP Country Lite on the swarmy build', () => {
    expect(resolveEdgeGeoip({ image: SWARMY_CADDY_IMAGE })).toEqual({ path: EDGE_GEOIP_BUNDLED_PATH, source: 'bundled' });
    expect(resolveEdgeGeoip({ setting: { mode: 'bundled' }, image: 'registry.local/caddy-swarmy:2' }).path).toBe(EDGE_GEOIP_BUNDLED_PATH);
  });

  it('a stock image has no matcher and no bundled file → not enforced', () => {
    expect(resolveEdgeGeoip({ image: STOCK })).toEqual({ path: '', source: 'unavailable' });
    expect(resolveEdgeGeoip({ image: '' }).source).toBe('unavailable');
  });

  it('file uses the operator path; a bad or missing path is unavailable, never rendered', () => {
    expect(resolveEdgeGeoip({ setting: { mode: 'file', path: '/geoip/country.mmdb' }, image: STOCK })).toEqual({ path: '/geoip/country.mmdb', source: 'file' });
    expect(resolveEdgeGeoip({ setting: { mode: 'file' }, image: SWARMY_CADDY_IMAGE }).source).toBe('unavailable');
    expect(resolveEdgeGeoip({ setting: { mode: 'file', path: '/x y.mmdb' }, image: SWARMY_CADDY_IMAGE }).path).toBe('');
  });

  it('off turns enforcement off even on the swarmy build', () => {
    expect(resolveEdgeGeoip({ setting: { mode: 'off' }, image: SWARMY_CADDY_IMAGE })).toEqual({ path: '', source: 'off' });
  });

  it('a raw extraConfig.geoipMmdbPath keeps winning until the setting is touched', () => {
    expect(resolveEdgeGeoip({ image: SWARMY_CADDY_IMAGE, legacyPath: '/data/geo.mmdb' }).path).toBe('/data/geo.mmdb');
    expect(resolveEdgeGeoip({ setting: { mode: 'off' }, image: SWARMY_CADDY_IMAGE, legacyPath: '/data/geo.mmdb' }).path).toBe('');
  });

  it('reads persisted settings tolerantly', () => {
    expect(readEdgeGeoipSetting({ mode: 'file', path: '/a.mmdb' })).toEqual({ mode: 'file', path: '/a.mmdb' });
    expect(readEdgeGeoipSetting({ mode: 'cloud' })).toBeNull();
    expect(readEdgeGeoipSetting(undefined)).toBeNull();
  });
});

describe('the bundled path reaches the country matcher', () => {
  it('renders maxmind_geolocation against the bundled database', () => {
    const out = buildCaddyfile(
      IngressConfigSchema.parse({
        driver: 'caddy',
        orgId: 'org_1',
        domains: [{ domain: 'a.example.com', service: 'web', port: 80, protection: { countryDeny: ['KP'] } }],
        globalOptions: { extraConfig: { geoipMmdbPath: resolveEdgeGeoip({ image: SWARMY_CADDY_IMAGE }).path } },
      }),
    );
    expect(out).toContain(`db_path ${EDGE_GEOIP_BUNDLED_PATH}`);
    expect(out).toContain('abort @geodeny_a_example_com');
  });
});
