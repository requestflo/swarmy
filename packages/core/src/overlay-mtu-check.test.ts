import { describe, expect, it } from 'bun:test';
import { checkOverlayMtu, overlaySamplesFrom, type OverlayMtuSample } from './overlay-mtu-check';
import { overlayContainerMtu, overlayFrameBytes, parseMtuOption } from './overlay-mtu';

const net = (name: string, o: Partial<OverlayMtuSample> = {}): OverlayMtuSample => ({
  name,
  encrypted: false,
  attachable: true,
  managed: true,
  ingress: false,
  ...o,
});

describe("Docker's overlay MTU arithmetic (libnetwork maxMTU)", () => {
  it('unset = 1500 link → containers get 1450 (1424 encrypted)', () => {
    expect(overlayContainerMtu(undefined, false)).toBe(1450);
    expect(overlayContainerMtu(undefined, true)).toBe(1424);
  });
  it('wt0 1280 → 1230 plain, 1204 encrypted, and the frame is exactly 1280', () => {
    expect(overlayContainerMtu(1280, false)).toBe(1230);
    expect(overlayContainerMtu(1280, true)).toBe(1204);
    expect(overlayFrameBytes(1230, false)).toBe(1280);
    expect(overlayFrameBytes(1204, true)).toBe(1280);
  });
  it("swarmy's older create-time values (1230 / 1170) fit, with room to spare", () => {
    expect(overlayContainerMtu(1230, false)).toBe(1180);
    expect(overlayContainerMtu(1170, true)).toBe(1092);
  });
  it('encrypted rounds down to a multiple of 4 so the ESP padding is 0', () => {
    expect(overlayContainerMtu(1283, true)).toBe(1204);
    expect(overlayFrameBytes(1207, true)).toBe(1284); // 1 byte of padding on an unaligned size
  });
  it('parses the option the way Docker does', () => {
    expect(parseMtuOption('1280')).toBe(1280);
    expect(parseMtuOption(' 1400 ')).toBe(1400);
    expect(parseMtuOption('')).toBeUndefined();
    expect(parseMtuOption('0')).toBeUndefined();
    expect(parseMtuOption('12x')).toBeUndefined();
    expect(parseMtuOption(undefined)).toBeUndefined();
  });
});

describe('overlaySamplesFrom (what the agent reports)', () => {
  it('keeps overlays only, reads the option/encrypted/labels, sorted by name', () => {
    expect(
      overlaySamplesFrom([
        { Name: 'shop_default', Driver: 'overlay', Attachable: true, Options: { 'com.docker.network.driver.vxlanid_list': '4097' }, Labels: { 'swarmy.managed': 'true', 'com.docker.stack.namespace': 'shop' } },
        { Name: 'bridge', Driver: 'bridge', Options: {} },
        { Name: 'ingress', Driver: 'overlay', Ingress: true, Options: null, Labels: null },
        { Name: 'swarmy', Driver: 'overlay', Attachable: true, Options: { encrypted: '', 'com.docker.network.driver.mtu': '1170' }, Labels: { 'swarmy.managed': 'true' } },
      ]),
    ).toEqual([
      { name: 'ingress', encrypted: false, attachable: false, managed: false, ingress: true },
      { name: 'shop_default', encrypted: false, attachable: true, managed: true, ingress: false, stack: 'shop' },
      { name: 'swarmy', mtu: 1170, encrypted: true, attachable: true, managed: true, ingress: false },
    ]);
  });
});

describe('checkOverlayMtu: wt0 1280 vs the overlays', () => {
  it('the board case: overlays at 1450 are too big; they need 1230 (1204 encrypted) via mtu=1280', () => {
    const c = checkOverlayMtu({
      iface: 'wt0',
      linkMtu: 1280,
      overlays: [
        net('shop_default', { stack: 'shop' }),
        net('swarmy', { mtu: 1280, encrypted: true }),
        net('legacy', { mtu: 1170, encrypted: true }),
        net('ingress', { managed: false, attachable: false, ingress: true }),
        net('vault', { encrypted: true, managed: false, attachable: false }),
      ],
    });
    expect(c.status).toBe('too-big');
    expect(c.option).toBe(1280);
    expect(c.fits).toEqual({ plain: 1230, encrypted: 1204 });
    expect(c.checked).toBe(5);
    expect(c.tooBig).toEqual([
      { name: 'ingress', encrypted: false, managed: false, ingress: true, mtu: 1450, fits: 1230, recreate: 'docker network create --driver overlay --ingress --opt com.docker.network.driver.mtu=1280 ingress' },
      {
        name: 'shop_default',
        encrypted: false,
        managed: true,
        ingress: false,
        stack: 'shop',
        mtu: 1450,
        fits: 1230,
        recreate:
          'docker network create --driver overlay --attachable --opt com.docker.network.driver.mtu=1280 --label swarmy.managed=true --label com.docker.stack.namespace=shop shop_default',
      },
      { name: 'vault', encrypted: true, managed: false, ingress: false, mtu: 1424, fits: 1204, recreate: 'docker network create --driver overlay --opt encrypted --opt com.docker.network.driver.mtu=1280 vault' },
    ]);
  });

  it('everything sized for the mesh → ok', () => {
    const c = checkOverlayMtu({ iface: 'wt0', linkMtu: 1280, overlays: [net('a', { mtu: 1280 }), net('b', { mtu: 1230, encrypted: true })] });
    expect(c).toMatchObject({ status: 'ok', checked: 2, tooBig: [] });
  });

  it('a 1281 option is one byte too big; a bigger link (no mesh, 1500) fits the defaults', () => {
    expect(checkOverlayMtu({ linkMtu: 1280, overlays: [net('a', { mtu: 1281 })] }).tooBig.map((f) => f.mtu)).toEqual([1231]);
    expect(checkOverlayMtu({ linkMtu: 1500, overlays: [net('a')] }).status).toBe('ok');
  });

  it('unknown until an agent reports both numbers (older agents report neither)', () => {
    expect(checkOverlayMtu({ iface: 'wt0', linkMtu: null, overlays: [net('a')] })).toMatchObject({ status: 'unknown', fits: null });
    expect(checkOverlayMtu({ iface: 'wt0', linkMtu: 1280, overlays: null })).toMatchObject({ status: 'unknown', option: 1280 });
  });
});
