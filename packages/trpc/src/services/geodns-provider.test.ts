import { describe, expect, it } from 'bun:test';
import {
  type ExistingRecord,
  type ProviderZoneSnapshot,
  desiredRecords,
  diffRecords,
  parseRoute53Rrsets,
  route53ChangeXml,
  syncProviderZone,
} from './geodns-provider';

function snap(endpoints: ProviderZoneSnapshot['endpoints']): ProviderZoneSnapshot {
  return { zone: 'geo.example.com', ttl: 30, endpoints };
}

describe('desiredRecords — health filtering + spill', () => {
  it('keeps only healthy endpoints when some are healthy', () => {
    const d = desiredRecords(
      snap([
        { host: 'app.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: true },
        { host: 'app.geo.example.com', region: 'eu-west', target: '2.2.2.2', healthy: false },
      ]),
    );
    expect(d).toEqual([
      { host: 'app.geo.example.com', type: 'A', value: '1.1.1.1', region: 'us-east' },
    ]);
  });

  it('spills to all endpoints when none are healthy (never NXDOMAIN)', () => {
    const d = desiredRecords(
      snap([
        { host: 'app.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: false },
        { host: 'app.geo.example.com', region: 'eu-west', target: '2.2.2.2', healthy: false },
      ]),
    );
    expect(d.map((r) => r.value)).toEqual(['1.1.1.1', '2.2.2.2']);
  });

  it('emits CNAME for non-IP targets', () => {
    const d = desiredRecords(
      snap([{ host: 'a.geo.example.com', region: 'us-east', target: 'lb.example.net', healthy: true }]),
    );
    expect(d[0]).toMatchObject({ type: 'CNAME', value: 'lb.example.net' });
  });
});

describe('diffRecords — create/delete/keep', () => {
  it('creates missing, deletes managed-and-stale, keeps matches', () => {
    const desired = desiredRecords(
      snap([{ host: 'app.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: true }]),
    );
    const existing: ExistingRecord[] = [
      // already correct → keep
      { id: 'r1', host: 'app.geo.example.com', type: 'A', value: '1.1.1.1', managed: true },
      // managed + no longer desired → delete
      { id: 'r2', host: 'app.geo.example.com', type: 'A', value: '9.9.9.9', managed: true },
      // unmanaged stale → never touch
      { id: 'r3', host: 'other.geo.example.com', type: 'A', value: '8.8.8.8', managed: false },
    ];
    const diff = diffRecords(desired, existing);
    expect(diff.create).toEqual([]);
    expect(diff.keep.map((k) => k.existing.id)).toEqual(['r1']);
    expect(diff.delete.map((d) => d.id)).toEqual(['r2']);
  });
});

describe('cloudflare adapter (injected fetch)', () => {
  it('lists, then creates the missing A and deletes the stale managed one', async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body as string | undefined });
      if (method === 'GET') {
        return new Response(
          JSON.stringify({
            result: [
              {
                id: 'stale1',
                type: 'A',
                name: 'app.geo.example.com',
                content: '9.9.9.9',
                ttl: 30,
                comment: 'swarmy:gslb region=eu-west',
              },
            ],
            result_info: { total_pages: 1 },
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await syncProviderZone(
      'cloudflare',
      snap([{ host: 'app.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: true }]),
      { zoneId: 'zone1', token: 'tok', fetchImpl },
    );

    expect(res.provider).toBe('cloudflare');
    expect(res.applied).toBe(2); // one create + one delete
    expect(res.errors).toEqual([]);
    const create = calls.find((c) => c.method === 'POST');
    expect(create?.url).toContain('/zones/zone1/dns_records');
    expect(create?.body).toContain('1.1.1.1');
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toContain('/dns_records/stale1');
  });

  it('honours dryRun (no write calls)', async () => {
    let writes = 0;
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') writes++;
      return new Response(JSON.stringify({ result: [], result_info: { total_pages: 1 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const res = await syncProviderZone(
      'cloudflare',
      snap([{ host: 'a.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: true }]),
      { zoneId: 'z', token: 't', fetchImpl, dryRun: true },
    );
    expect(writes).toBe(0);
    expect(res.planned).toHaveLength(1);
    expect(res.applied).toBe(0);
  });
});

describe('route53 helpers', () => {
  it('builds latency-routed UPSERT XML when a host spans regions', () => {
    const xml = route53ChangeXml([
      {
        action: 'UPSERT',
        name: 'app.geo.example.com.',
        type: 'A',
        value: '1.1.1.1',
        ttl: 30,
        setIdentifier: 'swarmy-us-east',
        awsRegion: 'us-east-1',
      },
    ]);
    expect(xml).toContain('<Action>UPSERT</Action>');
    expect(xml).toContain('<SetIdentifier>swarmy-us-east</SetIdentifier>');
    expect(xml).toContain('<Region>us-east-1</Region>');
    expect(xml).toContain('<Value>1.1.1.1</Value>');
  });

  it('parses managed rrsets (those carrying a SetIdentifier)', () => {
    const xml = `<ListResourceRecordSetsResponse><ResourceRecordSets>
      <ResourceRecordSet><Name>app.geo.example.com.</Name><Type>A</Type>
        <SetIdentifier>swarmy-us-east</SetIdentifier><Region>us-east-1</Region>
        <TTL>30</TTL><ResourceRecords><ResourceRecord><Value>1.1.1.1</Value></ResourceRecord></ResourceRecords>
      </ResourceRecordSet>
      <ResourceRecordSet><Name>plain.geo.example.com.</Name><Type>A</Type><TTL>30</TTL>
        <ResourceRecords><ResourceRecord><Value>2.2.2.2</Value></ResourceRecord></ResourceRecords>
      </ResourceRecordSet>
    </ResourceRecordSets></ListResourceRecordSetsResponse>`;
    const rows = parseRoute53Rrsets(xml);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.value === '1.1.1.1')?.managed).toBe(true);
    expect(rows.find((r) => r.value === '2.2.2.2')?.managed).toBe(false);
  });

  it('signs and posts a change batch through injected fetch', async () => {
    let signed: { url: string; auth?: string; body?: string } | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      signed = {
        url: typeof input === 'string' ? input : input.toString(),
        auth: headers.get('authorization') ?? undefined,
        body: init?.body as string | undefined,
      };
      return new Response('<ChangeResourceRecordSetsResponse/>', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await syncProviderZone(
      'route53',
      snap([
        { host: 'app.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: true },
        { host: 'app.geo.example.com', region: 'eu-west', target: '2.2.2.2', healthy: true },
      ]),
      { zoneId: 'Z123', token: 'AKID:secret', fetchImpl },
    );

    expect(res.provider).toBe('route53');
    expect(res.applied).toBe(2);
    expect(signed!.url).toContain('/hostedzone/Z123/rrset');
    expect(signed!.auth).toContain('AWS4-HMAC-SHA256 Credential=AKID/');
    expect(signed!.body).toContain('<SetIdentifier>swarmy-us-east</SetIdentifier>');
  });
});
