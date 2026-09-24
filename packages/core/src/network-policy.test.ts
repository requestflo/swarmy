import { describe, expect, it } from 'bun:test';
import { carryNetworkAliases, dropAliasesOnTargets, withInheritedMtu } from './docker';
import {
  linkAlias,
  linkNetworkName,
  meshLinkMtu,
  networkIsolationViolations,
  overlayDriverOptions,
  overlayMtuFor,
  parseLinksLabel,
  renderLinksLabel,
  stripPlatformAliases,
} from './network-policy';

describe('overlay MTU over the mesh', () => {
  it('NetBird/Tailscale wt0 1280 → overlay 1230 (VXLAN 50), 1170 encrypted', () => {
    expect(meshLinkMtu('netbird')).toBe(1280);
    expect(meshLinkMtu('tailscale')).toBe(1280);
    expect(overlayMtuFor(1280)).toBe(1230);
    expect(overlayMtuFor(1280, true)).toBe(1170);
  });
  it('raw WireGuard 1420 → 1370; no mesh → Docker default (unset)', () => {
    expect(overlayMtuFor(meshLinkMtu('wireguard'))).toBe(1370);
    expect(meshLinkMtu('none')).toBeUndefined();
    expect(overlayMtuFor(undefined)).toBeUndefined();
  });
  it('driver options: nothing for a mesh-less install; mtu when the mesh is on; driver_opts win', () => {
    expect(overlayDriverOptions({ meshDriver: 'netbird', meshEnabled: false })).toBeUndefined();
    expect(overlayDriverOptions({ meshDriver: 'netbird', meshEnabled: true })).toEqual({
      'com.docker.network.driver.mtu': '1230',
    });
    expect(overlayDriverOptions({ meshDriver: 'netbird', meshEnabled: true, encrypted: true })).toEqual({
      encrypted: '',
      'com.docker.network.driver.mtu': '1170',
    });
    expect(
      overlayDriverOptions({ meshDriver: 'netbird', meshEnabled: true, extra: { 'com.docker.network.driver.mtu': '1100' } }),
    ).toEqual({ 'com.docker.network.driver.mtu': '1100' });
  });
  it('agent-side: a new overlay inherits the platform overlay MTU unless one is given', () => {
    const nets = [{ Name: 'swarmy', Options: { encrypted: '', 'com.docker.network.driver.mtu': '1170' } }];
    expect(withInheritedMtu(undefined, nets)).toEqual({ 'com.docker.network.driver.mtu': '1170' });
    expect(withInheritedMtu({ 'com.docker.network.driver.mtu': '1400' }, nets)).toEqual({
      'com.docker.network.driver.mtu': '1400',
    });
    expect(withInheritedMtu(undefined, [{ Name: 'swarmy', Options: {} }])).toBeUndefined();
    // swarmy-control is preferred as the template.
    expect(
      withInheritedMtu(undefined, [...nets, { Name: 'swarmy-control', Options: { 'com.docker.network.driver.mtu': '1230' } }]),
    ).toEqual({ 'com.docker.network.driver.mtu': '1230' });
  });
});

describe('network isolation guard', () => {
  it('refuses swarmy-control and any alias on swarmy; allows plain swarmy + app nets', () => {
    const v = networkIsolationViolations([
      { name: 'ok_web', networks: ['ok_default', 'swarmy'], networkAliases: { ok_default: ['web'] } },
      { name: 'evil_pg', networks: ['swarmy'], networkAliases: { swarmy: ['postgres'] } },
      { name: 'evil_ctl', networks: ['swarmy-control'] },
    ]);
    expect(v.map((x) => [x.rule, x.resource])).toEqual([
      ['network.platform-alias', 'evil_pg'],
      ['network.control-plane', 'evil_ctl'],
    ]);
    expect(networkIsolationViolations([{ name: 'x', networks: ['swarmy'], networkAliases: { swarmy: [] } }])).toEqual([]);
    expect(networkIsolationViolations(undefined)).toEqual([]);
  });
  it('stripPlatformAliases drops only platform-network aliases', () => {
    const aliases: Record<string, string[]> = { a_default: ['web'], swarmy: ['web'], 'swarmy-control': ['x'] };
    expect(stripPlatformAliases({ networkAliases: aliases })).toEqual({ networkAliases: { a_default: ['web'] } });
  });
});

describe('connect apps', () => {
  it('link network is order-free, org-qualified and stable', () => {
    const n = linkNetworkName('org1', 'shop', 'billing');
    expect(n).toBe(linkNetworkName('org1', 'billing', 'shop'));
    expect(n).not.toBe(linkNetworkName('org2', 'shop', 'billing'));
    expect(n).toMatch(/^swarmy-link-[0-9a-f]{16}$/);
    expect(n).toMatchSnapshot();
  });
  it('alias + label helpers', () => {
    expect(linkAlias('billing', 'api')).toBe('api.billing');
    expect(parseLinksLabel(' b,a,,b ')).toEqual(['a', 'b']);
    expect(renderLinksLabel(['search', 'billing', 'search'])).toBe('billing,search');
  });
});

describe('agent safety floor — no aliases on platform overlays', () => {
  it('a legacy alias carried from the live service onto `swarmy` is dropped; app-net alias kept', () => {
    const opts: { TaskTemplate: { Networks: Array<{ Target: string; Aliases?: string[] }> } } = {
      TaskTemplate: { Networks: [{ Target: 'id-app' }, { Target: 'id-swarmy' }] },
    };
    carryNetworkAliases(opts, {}, [
      { Target: 'id-app', Aliases: ['web'] },
      { Target: 'id-swarmy', Aliases: ['postgres'] },
    ]);
    dropAliasesOnTargets(opts, new Set(['id-swarmy']));
    expect(opts.TaskTemplate.Networks).toEqual([{ Target: 'id-app', Aliases: ['web'] }, { Target: 'id-swarmy' }]);
  });
});
