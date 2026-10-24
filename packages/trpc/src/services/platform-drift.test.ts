import { describe, expect, it } from 'bun:test';
import { buildPlatformManifest } from '@swarmy/core/platform-manifest';
import { planDrift, tagOf } from './platform-drift';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const release = buildPlatformManifest({
  version: '1.3.0',
  channel: 'stable',
  commit: 'n',
  digests: { controller: D('b'), dns: D('d'), caddySwarmy: D('e') },
});
const C = release.components;

describe('planDrift — system services off the current release', () => {
  it('a service on the release digest (direct or mirrored) is quiet; user services are never looked at', () => {
    const rows = planDrift(
      [
        { name: 'swarmy_controller', image: `ghcr.io/requestflo/swarmy-controller:latest@${D('b')}` },
        { name: 'swarmy-dns', image: `localhost:5000/swarmy-system/ghcr.io/requestflo/swarmy-dns:latest@${D('d')}` },
        { name: 'swarmy-clickhouse', image: `clickhouse/clickhouse-server:24.8-alpine@${C.clickhouse!.digest}` },
        { name: 'shop_web', image: 'ghcr.io/requestflo/swarmy-dns:latest' },
      ],
      C,
    );
    expect(rows).toEqual([]);
  });

  it('the edges on another build and DNS on a floating tag can be re-pinned; the controller is explained', () => {
    const rows = planDrift(
      [
        { name: 'swarmy-ingress-caddy', image: `ghcr.io/requestflo/caddy-swarmy:latest@${D('1')}` },
        { name: 'swarmy-dns', image: 'ghcr.io/requestflo/swarmy-dns:latest' },
        { name: 'swarmy_controller', image: `ghcr.io/requestflo/swarmy-controller:latest@${D('2')}` },
      ],
      C,
    );
    expect(rows).toEqual([
      {
        service: 'swarmy_controller',
        key: 'controller',
        owner: 'controller',
        running: `ghcr.io/requestflo/swarmy-controller:latest@${D('2')}`,
        expected: `ghcr.io/requestflo/swarmy-controller@${D('b')}`,
        kind: 'digest',
        action: 'explain',
      },
      {
        service: 'swarmy-dns',
        key: 'dns',
        owner: 'system',
        running: 'ghcr.io/requestflo/swarmy-dns:latest',
        expected: `ghcr.io/requestflo/swarmy-dns@${D('d')}`,
        kind: 'floating',
        action: 'repin',
      },
      {
        service: 'swarmy-ingress-caddy',
        key: 'caddySwarmy',
        owner: 'system',
        running: `ghcr.io/requestflo/caddy-swarmy:latest@${D('1')}`,
        expected: `ghcr.io/requestflo/caddy-swarmy@${D('e')}`,
        kind: 'digest',
        action: 'repin',
      },
    ]);
  });

  it('Garage on v1 is a pending migration, not drift; a v2 store on another build is explained, never re-pinned', () => {
    expect(planDrift([{ name: 'swarmy-garage', image: `dxflrs/garage:v1.0.1@${C.garageV1!.digest}` }], C)).toEqual([]);
    const [row] = planDrift([{ name: 'swarmy-garage', image: `dxflrs/garage:v2.4.1@${D('7')}` }], C);
    expect(row).toMatchObject({ key: 'garage', owner: 'engine', kind: 'digest', action: 'explain' });
  });

  it('a development release names no exact build: same tag is quiet, another tag is explained with nothing to pin to', () => {
    const dev = buildPlatformManifest({ version: '0.0.0', channel: 'edge', commit: 'dev' }).components;
    expect(planDrift([{ name: 'swarmy-dns', image: `ghcr.io/requestflo/swarmy-dns:latest@${D('3')}` }], dev)).toEqual([]);
    expect(planDrift([{ name: 'swarmy-dns', image: 'ghcr.io/requestflo/swarmy-dns:1.1.0' }], dev)).toEqual([
      { service: 'swarmy-dns', key: 'dns', owner: 'system', running: 'ghcr.io/requestflo/swarmy-dns:1.1.0', expected: null, kind: 'tag', action: 'explain' },
    ]);
  });

  it('tagOf reads the tag past a registry port and before a digest', () => {
    expect(tagOf(`localhost:5000/x/caddy:2-alpine@${D('a')}`)).toBe('2-alpine');
    expect(tagOf('localhost:5000/x/caddy')).toBeNull();
  });
});
