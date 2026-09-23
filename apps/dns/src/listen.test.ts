import { describe, expect, it } from 'bun:test';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  ListenerSet,
  parseListenOverride,
  selectAdminListenAddresses,
  selectDnsListenAddresses,
} from './listen';

const v4 = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as NetworkInterfaceInfo;
const v6 = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, family: 'IPv6', internal, netmask: 'ffff:ffff:ffff:ffff::', mac: '00:00:00:00:00:00', cidr: null, scopeid: 0 }) as NetworkInterfaceInfo;

/** A stock DigitalOcean Ubuntu 24.04 droplet on the host netns. */
const droplet = {
  lo: [v4('127.0.0.1', true), v6('::1', true)],
  eth0: [v4('159.65.10.20'), v4('10.19.0.5'), v6('2a03:b0c0:3:d0::1a2b:1'), v6('fe80::a8bb:ccff:fedd:eeff')],
  eth1: [v4('10.110.0.3'), v6('FE80::1')],
  docker0: [v4('172.17.0.1')],
  docker_gwbridge: [v4('172.18.0.1')],
  weird: [v4('169.254.169.254'), v4('127.0.0.53')],
};

describe('selectDnsListenAddresses', () => {
  it('binds every non-loopback address individually — never 0.0.0.0, never the resolved stub', () => {
    const addrs = selectDnsListenAddresses(droplet);
    expect(addrs).toEqual([
      '10.110.0.3',
      '10.19.0.5',
      '159.65.10.20',
      '172.17.0.1',
      '172.18.0.1',
      '2a03:b0c0:3:d0::1a2b:1',
    ]);
    expect(addrs).not.toContain('0.0.0.0');
    expect(addrs).not.toContain('127.0.0.53');
    expect(addrs).not.toContain('127.0.0.1');
    expect(addrs).not.toContain('::1');
  });

  it('excludes IPv6 link-local (any case) and IPv4 link-local', () => {
    const addrs = selectDnsListenAddresses(droplet);
    expect(addrs.some((a) => a.toLowerCase().startsWith('fe80'))).toBe(false);
    expect(addrs).not.toContain('169.254.169.254');
    expect(selectDnsListenAddresses({ x: [v6('febf::1'), v6('fec0::1')] })).toEqual(['fec0::1']);
  });

  it('accepts numeric family (older Node shape) and de-duplicates', () => {
    const numeric = { ...v4('203.0.113.9'), family: 4 } as unknown as NetworkInterfaceInfo;
    expect(selectDnsListenAddresses({ a: [numeric], b: [v4('203.0.113.9')] })).toEqual(['203.0.113.9']);
  });
});

describe('selectAdminListenAddresses', () => {
  it('is loopback + the docker bridges only — never a public address', () => {
    expect(selectAdminListenAddresses(droplet)).toEqual(['127.0.0.1', '172.17.0.1', '172.18.0.1']);
    expect(selectAdminListenAddresses({ eth0: [v4('159.65.10.20')] })).toEqual(['127.0.0.1']);
  });
});

describe('parseListenOverride (SWARMY_DNS_LISTEN)', () => {
  it('parses a comma list, trims, de-dups; empty = auto', () => {
    expect(parseListenOverride(' 10.0.0.1, 2001:db8::1 ,10.0.0.1')).toEqual(['10.0.0.1', '2001:db8::1']);
    expect(parseListenOverride('')).toBeUndefined();
    expect(parseListenOverride(' , ')).toBeUndefined();
    expect(parseListenOverride(undefined)).toBeUndefined();
  });
});

describe('ListenerSet', () => {
  it('binds new addresses, closes vanished ones, retries failed binds on the next scan', async () => {
    let addrs = ['10.0.0.1', '192.168.122.1'];
    const closed: string[] = [];
    let busy = true; // 192.168.122.1:53 held by a libvirt dnsmasq at first
    const set = new ListenerSet('test', () => addrs, (address) => {
      if (address === '192.168.122.1' && busy) throw new Error('EADDRINUSE');
      return { close: () => closed.push(address) };
    });

    const first = await set.sync();
    expect(first.added).toEqual(['10.0.0.1']);
    expect(first.failed.map((f) => f.address)).toEqual(['192.168.122.1']);
    expect(set.addresses()).toEqual(['10.0.0.1']);

    busy = false;
    addrs = ['10.0.0.2', '192.168.122.1']; // DHCP moved 10.0.0.1 → 10.0.0.2
    const second = await set.sync();
    expect(second.removed).toEqual(['10.0.0.1']);
    expect(second.added.sort()).toEqual(['10.0.0.2', '192.168.122.1']);
    expect(closed).toEqual(['10.0.0.1']);

    const steady = await set.sync();
    expect(steady).toEqual({ added: [], removed: [], failed: [] });

    set.close();
    expect(closed.sort()).toEqual(['10.0.0.1', '10.0.0.2', '192.168.122.1']);
    expect(set.addresses()).toEqual([]);
  });

  it('never overlaps two scans (no double bind)', async () => {
    let binds = 0;
    const set = new ListenerSet('test', () => ['10.0.0.1'], async () => {
      binds++;
      await Bun.sleep(5);
      return { close: () => undefined };
    });
    await Promise.all([set.sync(), set.sync()]);
    expect(binds).toBe(1);
    set.close();
  });

  it('binds a real UDP socket per address (loopback override)', async () => {
    const set = new ListenerSet('udp', () => ['127.0.0.1'], async (host) => {
      const sock = await Bun.udpSocket({ hostname: host, port: 0 });
      return { close: () => sock.close() };
    });
    const r = await set.sync();
    expect(r.added).toEqual(['127.0.0.1']);
    set.close();
  });
});
