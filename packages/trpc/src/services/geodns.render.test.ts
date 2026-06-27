import { describe, expect, it } from 'bun:test';
import {
  endpointsToSteerTargets,
  planHosts,
  renderCoreDns,
  type ZoneSnapshot,
} from './geodns.service';

function snap(endpoints: ZoneSnapshot['endpoints']): ZoneSnapshot {
  return { zone: 'geo.example.com', ttl: 30, provider: 'coredns', endpoints };
}

describe('planHosts — health filtering & failover', () => {
  it('drops unhealthy regions from the answer set', () => {
    const plan = planHosts(
      snap([
        { host: 'app.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: true },
        { host: 'app.geo.example.com', region: 'eu-west', target: '2.2.2.2', healthy: false },
      ]),
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]!.selected.map((e) => e.region)).toEqual(['us-east']);
    expect(plan[0]!.degraded).toBe(false);
  });

  it('spills to all endpoints (flagged degraded) when every region is unhealthy', () => {
    const plan = planHosts(
      snap([
        { host: 'app.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: false },
        { host: 'app.geo.example.com', region: 'eu-west', target: '2.2.2.2', healthy: false },
      ]),
    );
    expect(plan[0]!.degraded).toBe(true);
    expect(plan[0]!.selected).toHaveLength(2);
  });

  it('orders hosts and known-coordinate regions deterministically', () => {
    const plan = planHosts(
      snap([
        { host: 'b.geo.example.com', region: 'eu-west', target: '2.2.2.2', healthy: true },
        { host: 'a.geo.example.com', region: 'zz-unknown', target: '3.3.3.3', healthy: true },
        { host: 'a.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: true },
      ]),
    );
    expect(plan.map((p) => p.host)).toEqual(['a.geo.example.com', 'b.geo.example.com']);
    // Known-coordinate region (us-east) before unknown (zz-unknown).
    expect(plan[0]!.selected.map((e) => e.region)).toEqual(['us-east', 'zz-unknown']);
  });
});

describe('renderCoreDns — golden zone + Corefile', () => {
  it('renders a health-filtered zonefile with a fixed serial', () => {
    const rendered = renderCoreDns(
      snap([
        { host: 'app.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: true },
        { host: 'app.geo.example.com', region: 'eu-west', target: '2.2.2.2', healthy: false },
        { host: 'cname.geo.example.com', region: 'us-east', target: 'lb.example.net', healthy: true },
      ]),
      { serial: 42 },
    );

    const zone = rendered.files.find((f) => f.path.endsWith('.zone'))!.contents;
    expect(zone).toBe(
      [
        '$ORIGIN geo.example.com.',
        '$TTL 30',
        '@\tIN\tSOA\tns.geo.example.com. admin.geo.example.com. ( 42 7200 3600 1209600 30 )',
        '@\tIN\tNS\tns.geo.example.com.',
        'app\tIN\tA\t1.1.1.1\t; region=us-east',
        'cname\tIN\tCNAME\tlb.example.net\t; region=us-east',
        '',
      ].join('\n'),
    );
  });

  it('renders a Corefile with geoip + edns-subnet + health plugins', () => {
    const rendered = renderCoreDns(snap([]), { serial: 1 });
    const corefile = rendered.files.find((f) => f.path.endsWith('Corefile'))!.contents;
    expect(corefile).toContain('geo.example.com:53 {');
    expect(corefile).toContain('geoip /etc/coredns/GeoLite2-City.mmdb');
    expect(corefile).toContain('edns-subnet');
    expect(corefile).toContain('health');
    expect(corefile).toContain('cache 30');
  });

  it('is deterministic across renders with the same serial (golden stable)', () => {
    const s = snap([
      { host: 'app.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: true },
    ]);
    expect(renderCoreDns(s, { serial: 7 })).toEqual(renderCoreDns(s, { serial: 7 }));
  });

  it('flags degraded hosts in the summary', () => {
    const rendered = renderCoreDns(
      snap([{ host: 'app.geo.example.com', region: 'us-east', target: '1.1.1.1', healthy: false }]),
      { serial: 1 },
    );
    expect(rendered.summary).toContain('DEGRADED');
  });
});

describe('endpointsToSteerTargets', () => {
  it('maps endpoints to steer targets preserving health', () => {
    const targets = endpointsToSteerTargets([
      { host: 'a', region: 'us-east', target: '1.1.1.1', healthy: true },
      { host: 'a', region: 'eu-west', target: '2.2.2.2', healthy: false },
    ]);
    expect(targets).toEqual([
      { target: '1.1.1.1', region: 'us-east', healthy: true },
      { target: '2.2.2.2', region: 'eu-west', healthy: false },
    ]);
  });
});
