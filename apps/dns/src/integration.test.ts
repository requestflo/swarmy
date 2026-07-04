import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dnsPacket, { type Packet } from 'dns-packet';
import type { DnsSnapshotBundle } from '@swarmy/core/protocol';
import { SnapshotStore } from './store';
import { GeoIpManager } from './geoip-manager';
import { createMetrics } from './metrics';
import { startUdpServer } from './server-udp';
import { startTcpServer } from './server-tcp';
import { startAdminServer } from './admin';
import type { QueryContext } from './query';
import type { DnsServerConfig } from './config';

const DNS_PORT = 15353;
const ADMIN_PORT = 15354;
const TOKEN = 'test-admin-token';

const bundle = (version: number): DnsSnapshotBundle => ({
  version,
  generatedAt: new Date().toISOString(),
  zones: [
    {
      zone: 'example.com',
      serial: version,
      ttl: 30,
      soa: {
        mname: 'ns1.example.com',
        rname: 'hostmaster.example.com',
        refresh: 7200,
        retry: 3600,
        expire: 1209600,
        minimum: 30,
      },
      nameservers: [
        { label: 'ns1', fqdn: 'ns1.example.com', ip: '203.0.113.10', nodeId: 'n1' },
        { label: 'ns2', fqdn: 'ns2.example.com', ip: '198.51.100.20', nodeId: 'n2' },
      ],
      geoRecords: [
        {
          host: 'app.example.com',
          maxAnswers: 2,
          endpoints: [
            { nodeId: 'n1', region: 'eu-west', ip: '203.0.113.10', healthy: true },
            { nodeId: 'n2', region: 'af', ip: '198.51.100.20', healthy: true },
          ],
        },
      ],
      staticRecords: [{ name: '@', type: 'TXT', value: 'v=spf1 -all' }],
    },
  ],
});

async function udpQuery(packet: Packet): Promise<ReturnType<typeof dnsPacket.decode>> {
  const query = dnsPacket.encode(packet);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('udp query timeout')), 2000);
    void Bun.udpSocket({
      socket: {
        data(sock, buf) {
          clearTimeout(timer);
          sock.close();
          resolve(dnsPacket.decode(Buffer.from(buf)));
        },
      },
    }).then((sock) => sock.send(query, DNS_PORT, '127.0.0.1'));
  });
}

let cleanup: Array<() => void> = [];
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'swarmy-dns-test-'));
  const config: DnsServerConfig = {
    port: DNS_PORT,
    adminPort: ADMIN_PORT,
    host: '127.0.0.1',
    dataDir,
    geoipSource: 'off',
    geoipFile: undefined,
    adminToken: TOKEN,
    allowInsecureAdmin: false,
  };
  const store = new SnapshotStore(dataDir);
  await store.load();
  const geoip = new GeoIpManager(config);
  const metrics = createMetrics();
  const ctx: QueryContext = { store, metrics, geoip: () => geoip.current() };
  const udp = await startUdpServer(ctx, config.host, config.port);
  const tcp = startTcpServer(ctx, config.host, config.port);
  const admin = startAdminServer(config, store, metrics, geoip);
  cleanup = [() => udp.close(), () => tcp.close(), () => admin.close()];
});

afterAll(async () => {
  for (const fn of cleanup) fn();
  await rm(dataDir, { recursive: true, force: true });
});

const adminFetch = (path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${ADMIN_PORT}${path}`, init);

describe('admin API', () => {
  it('rejects unauthenticated pushes (fail closed)', async () => {
    const res = await adminFetch('/v1/snapshot', {
      method: 'POST',
      body: JSON.stringify(bundle(1)),
    });
    expect(res.status).toBe(401);
  });

  it('accepts an authorized versioned bundle', async () => {
    const res = await adminFetch('/v1/snapshot', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(bundle(1)),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: true, version: 1, zones: 1 });
  });

  it('rejects stale versions with 409', async () => {
    await adminFetch('/v1/snapshot', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(bundle(3)),
    });
    const res = await adminFetch('/v1/snapshot', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(bundle(2)),
    });
    expect(res.status).toBe(409);
  });

  it('reports status', async () => {
    const res = await adminFetch('/v1/status');
    const status = (await res.json()) as { version: number; zones: Array<{ zone: string }> };
    expect(status.version).toBe(3);
    expect(status.zones[0]?.zone).toBe('example.com');
  });
});

describe('DNS over UDP', () => {
  it('answers A queries authoritatively from the pushed snapshot', async () => {
    const res = await udpQuery({
      id: 42,
      type: 'query',
      flags: dnsPacket.RECURSION_DESIRED,
      questions: [{ name: 'app.example.com', type: 'A' }],
    } as Packet);
    expect(res.id).toBe(42);
    expect(res.flag_aa).toBe(true);
    const ips = (res.answers ?? []).map((a) => (a as { data: string }).data).sort();
    expect(ips).toEqual(['198.51.100.20', '203.0.113.10']);
  });

  it('serves NS + glue, SOA, TXT, NXDOMAIN, REFUSED', async () => {
    const ns = await udpQuery({
      id: 1, type: 'query', questions: [{ name: 'example.com', type: 'NS' }],
    } as Packet);
    expect((ns.answers ?? []).map((a) => (a as { data: string }).data).sort()).toEqual([
      'ns1.example.com',
      'ns2.example.com',
    ]);
    expect(ns.additionals?.filter((a) => a.type === 'A')).toHaveLength(2);

    const soa = await udpQuery({
      id: 2, type: 'query', questions: [{ name: 'example.com', type: 'SOA' }],
    } as Packet);
    expect((soa.answers?.[0] as { data: { serial: number } }).data.serial).toBe(3);

    const txt = await udpQuery({
      id: 3, type: 'query', questions: [{ name: 'example.com', type: 'TXT' }],
    } as Packet);
    expect(txt.answers?.[0]?.type).toBe('TXT');

    const nx = await udpQuery({
      id: 4, type: 'query', questions: [{ name: 'nope.example.com', type: 'A' }],
    } as Packet);
    expect((nx as unknown as { rcode: string }).rcode).toBe('NXDOMAIN');
    expect(nx.authorities?.[0]?.type).toBe('SOA');

    const refused = await udpQuery({
      id: 5, type: 'query', questions: [{ name: 'other.net', type: 'A' }],
    } as Packet);
    expect((refused as unknown as { rcode: string }).rcode).toBe('REFUSED');
  });
});

describe('DNS over TCP', () => {
  it('answers length-prefixed queries (dig +tcp)', async () => {
    const framed = dnsPacket.streamEncode({
      id: 7,
      type: 'query',
      questions: [{ name: 'app.example.com', type: 'A' }],
    } as Packet);
    const response = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tcp timeout')), 2000);
      let acc = Buffer.alloc(0);
      void Bun.connect({
        hostname: '127.0.0.1',
        port: DNS_PORT,
        socket: {
          open(socket) {
            socket.write(framed);
          },
          data(socket, chunk) {
            acc = Buffer.concat([acc, chunk]);
            if (acc.byteLength >= 2 && acc.byteLength >= 2 + acc.readUInt16BE(0)) {
              clearTimeout(timer);
              socket.end();
              resolve(acc);
            }
          },
        },
      });
    });
    const decoded = dnsPacket.streamDecode(response);
    expect(decoded.id).toBe(7);
    expect(decoded.answers?.length).toBe(2);
  });
});

describe('persistence', () => {
  it('a fresh store loads the persisted bundle (controller-outage survival)', async () => {
    const revived = new SnapshotStore(dataDir);
    await revived.load();
    expect(revived.version).toBe(3);
    expect(revived.current?.zones[0]?.zone).toBe('example.com');
  });
});
