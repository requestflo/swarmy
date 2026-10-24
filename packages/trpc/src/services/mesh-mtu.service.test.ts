import { describe, expect, it } from 'bun:test';
import type { OverlayMtuSample } from '@swarmy/core';
import { MeshMtuLiveStore, mergeMtuReports, type MeshMtuReport } from './mesh-mtu.service';

const ov = (name: string, mtu?: number): OverlayMtuSample => ({
  name,
  ...(mtu ? { mtu } : {}),
  encrypted: false,
  attachable: true,
  managed: true,
  ingress: false,
});
const rep = (r: Partial<MeshMtuReport>): MeshMtuReport => ({ iface: 'wt0', linkMtu: 1280, overlays: [], at: 0, ...r });

describe('mergeMtuReports (every node → one check input)', () => {
  it('the smallest tunnel binds; overlays merge by name, keeping the biggest option', () => {
    expect(
      mergeMtuReports([
        rep({ linkMtu: 1420, overlays: [ov('shop_default', 1280), ov('swarmy', 1280)] }),
        rep({ linkMtu: 1280, overlays: [ov('shop_default')] }),
      ]),
    ).toEqual({ iface: 'wt0', linkMtu: 1280, overlays: [ov('shop_default'), ov('swarmy', 1280)] });
  });

  it("no readable interface MTU: the driver's default stands in once overlays are known", () => {
    expect(mergeMtuReports([rep({ iface: null, linkMtu: null, overlays: [ov('a')] })], 1280).linkMtu).toBe(1280);
    expect(mergeMtuReports([rep({ linkMtu: null, overlays: null })], 1280)).toEqual({ iface: 'wt0', linkMtu: null, overlays: null });
    expect(mergeMtuReports([], 1280)).toEqual({ iface: null, linkMtu: null, overlays: null });
  });
});

describe('MeshMtuLiveStore', () => {
  it('ignores older agents, keeps the latest per node, and forgets stale reports', () => {
    const s = new MeshMtuLiveStore();
    s.report('org', 'n1', {}, 1_000);
    expect(s.fresh('org', 1_000)).toEqual([]);
    s.report('org', 'n1', { interface: 'wt0', interfaceMtu: 1280, overlays: [ov('a')] }, 1_000);
    s.report('org', 'n1', { interface: 'wt0', interfaceMtu: 1280, overlays: [ov('b')] }, 2_000);
    s.report('org', 'n2', { interfaceMtu: 1280 }, 2_000);
    s.report('other', 'n9', { interfaceMtu: 1500 }, 2_000);
    expect(s.fresh('org', 2_000).map((r) => r.overlays?.map((o) => o.name) ?? null)).toEqual([['b'], null]);
    expect(s.fresh('org', 2_000 + 120_001)).toEqual([]);
  });
});
