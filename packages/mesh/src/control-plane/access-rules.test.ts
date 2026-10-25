import { describe, expect, it } from 'bun:test';
import { HeadscaleDriver } from '../drivers/headscale';
import { NetbirdDriver } from '../drivers/netbird';
import { NoneDriver } from '../drivers/none';
import type { DriverControlPlane, MeshConfig, MeshDriver, PolicyAdminApi } from '../types';
import { accessRuleWords, groupWords } from './access-rule-words';
import { checkNewRule, policiesToRules } from './access-rules';
import type { NbGroup, NbPolicy } from './netbird-admin';

const GROUPS: NbGroup[] = [
  { id: 'g-all', name: 'All' },
  { id: 'g-nodes', name: 'swarmy:lon:nodes' },
  { id: 'g-acc', name: 'swarmy:lon:access:st1' },
  { id: 'g-srv', name: 'Servers' },
  { id: 'g-db', name: 'Databases' },
  { id: 'g-office', name: 'Office' },
];
const rule = (p: Partial<NbPolicy['rules'][number]>): NbPolicy['rules'][number] => ({ name: 'r', enabled: true, action: 'accept', bidirectional: false, protocol: 'tcp', ...p });
const POLICIES: NbPolicy[] = [
  { id: 'p-nodes', name: 'swarmy-lon-nodes', enabled: true, rules: [rule({ bidirectional: true, protocol: 'all', sources: ['g-nodes'], destinations: ['g-nodes'] })] },
  { id: 'p-db', name: 'swarmy-lon-st1-db', enabled: true, rules: [rule({ ports: ['5432'], sources: [{ id: 'g-acc', name: 'swarmy:lon:access:st1' }], destinations: [], destinationResource: { id: 'res1', type: 'host' } })] },
  { id: 'p-mine', name: 'Servers to DB', enabled: true, rules: [rule({ ports: ['5432'], sources: [{ id: 'g-srv', name: 'Servers' }], destinations: [{ id: 'g-db', name: 'Databases' }] })] },
  { id: 'p-office', name: 'Office ops', enabled: false, rules: [rule({ ports: ['22', '443'], port_ranges: [{ start: 8000, end: 8100 }], sources: ['g-office'], destinations: ['g-srv', 'g-db'] })] },
];
const STACKS = { stacks: [{ id: 'st1', name: 'storefront' }] };

/** An in-memory NetBird with just groups and policies. */
function memory(): PolicyAdminApi & { policies: NbPolicy[] } {
  const policies = structuredClone(POLICIES);
  return {
    policies,
    listGroups: async () => GROUPS,
    listPolicies: async () => policies,
    createPolicy: async (p) => (policies.push({ ...p, id: `p-${policies.length}` }), policies[policies.length - 1]!),
    deletePolicy: async (id) => void policies.splice(policies.findIndex((p) => p.id === id), 1),
  };
}
const config: MeshConfig = { driver: 'netbird', enabled: true, orgId: 'o1', controlPlane: { mode: 'external' }, settings: {} };
const control = (policies?: PolicyAdminApi): DriverControlPlane => ({ createSetupKey: async () => ({ setupKey: 'k' }), listPeers: async () => [], revokePeer: async () => {}, policies });

describe('mesh access rules: NetBird policies in plain words', () => {
  it("lists every rule as a sentence, swarmy's own named for what they are", () => {
    const rules = policiesToRules(POLICIES, GROUPS);
    expect(rules.map((r) => accessRuleWords(r, STACKS))).toEqual([
      'Servers can reach each other on every port',
      "People allowed on storefront can reach storefront's db on 5432",
      'Servers can reach Databases on 5432',
      'Office can reach Servers and Databases on 22, 443 and 8000-8100 (switched off)',
    ]);
    expect(rules.map((r) => [r.id, r.managedBySwarmy, r.simple])).toEqual([
      ['p-nodes', true, true],
      ['p-db', true, false],
      ['p-mine', false, true],
      ['p-office', false, false],
    ]);
  });

  it('says protocols and directions the way a person would', () => {
    const base = policiesToRules([POLICIES[2]!], GROUPS)[0]!;
    expect(accessRuleWords({ ...base, protocol: 'udp', ports: ['53'] })).toBe('Servers can reach Databases on UDP 53');
    expect(accessRuleWords({ ...base, ports: [] })).toBe('Servers can reach Databases on every TCP port');
    expect(accessRuleWords({ ...base, protocol: 'icmp', ports: [] })).toBe('Servers can reach Databases with ping');
    expect(accessRuleWords({ ...base, bidirectional: true })).toBe('Servers and Databases can reach each other on 5432');
    expect(accessRuleWords({ ...base, action: 'drop' })).toBe("Servers can't reach Databases on 5432");
    expect(groupWords('All')).toBe('Every device');
    expect(groupWords('swarmy:lon:router:st9')).toBe("st9's router");
  });

  it("a new rule names only your own groups, real ports, and isn't a duplicate", () => {
    const list = { rules: policiesToRules(POLICIES, GROUPS), groups: ['Databases', 'Office', 'Servers'] };
    expect(checkNewRule({ from: 'Office', to: 'Databases', protocol: 'tcp', ports: [5432] }, list)).toBeNull();
    expect(checkNewRule({ from: 'swarmy:lon:nodes', to: 'Databases', protocol: 'tcp', ports: [5432] }, list)).toContain("isn't a group you can use");
    expect(checkNewRule({ from: 'All', to: 'Databases', protocol: 'tcp', ports: [5432] }, list)).toContain("isn't a group you can use");
    expect(checkNewRule({ from: 'Office', to: 'Databases', protocol: 'tcp', ports: [70000] }, list)).toBe("70000 isn't a port (1 to 65535)");
    expect(checkNewRule({ from: 'Office', to: 'Databases', protocol: 'all', ports: [22] }, list)).toContain('leave the ports out');
    expect(checkNewRule({ from: 'Servers', to: 'Databases', protocol: 'tcp', ports: [5432] }, list)).toBe('that rule already exists (Servers to DB)');
  });

  it('the NetBird driver adds a one-way rule outside swarmy\'s namespace and removes only simple rules of yours', async () => {
    const api = memory();
    const d = new NetbirdDriver();
    const added = await d.addAccessRule(config, { from: 'Office', to: 'Databases', protocol: 'tcp', ports: [6379, 5432] }, control(api));
    expect(added).toMatchObject({ name: 'Office → Databases tcp/5432,6379', from: ['Office'], to: ['Databases'], ports: ['5432', '6379'], managedBySwarmy: false, simple: true });
    expect(api.policies.at(-1)!.rules[0]).toMatchObject({ sources: ['g-office'], destinations: ['g-db'], bidirectional: false, action: 'accept' });
    await d.removeAccessRule(config, added.id, control(api));
    expect(api.policies.map((p) => p.id)).toEqual(['p-nodes', 'p-db', 'p-mine', 'p-office']);
    await expect(d.removeAccessRule(config, 'p-nodes', control(api))).rejects.toThrow("swarmy-lon-nodes is swarmy's own rule");
    await expect(d.removeAccessRule(config, 'p-office', control(api))).rejects.toThrow('change it in NetBird');
    await expect(d.addAccessRule(config, { from: 'Office', to: 'All', protocol: 'tcp', ports: [] }, control(api))).rejects.toThrow("All isn't a group you can use");
    expect((await d.listAccessRules(config, control(api))).groups).toEqual(['Databases', 'Office', 'Servers']);
    await expect(d.listAccessRules(config, control())).rejects.toThrow('no NetBird Admin API');
  });

  it('Headscale and none leave access rules out (callers check for the method)', () => {
    for (const d of [new HeadscaleDriver(), new NoneDriver()] as MeshDriver[]) {
      expect(d.listAccessRules).toBeUndefined();
      expect(d.addAccessRule).toBeUndefined();
      expect(d.removeAccessRule).toBeUndefined();
    }
  });
});
