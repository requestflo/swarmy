import { describe, expect, test } from 'bun:test';
import type {
  NbAccount,
  NbGroup,
  NbIdentityProvider,
  NbNetwork,
  NbPeerFull,
  NbPolicy,
  NbRecord,
  NbResource,
  NbRouter,
  NbUser,
  NbZone,
  NetbirdAdminApi,
} from './netbird-admin';
import {
  applyPeopleAccessPlan,
  applyUserSync,
  bootstrapControlPlane,
  ensureSwarmyConnector,
  listPeoplePeers,
  pruneGroups,
} from './people-sync';
import { buildPeopleAccessPlan, type PeopleAccessIntent } from '../people';

/** An in-memory NetBird: just enough of the Admin API's behaviour to test the diff. */
class FakeNetbird implements NetbirdAdminApi {
  private n = 0;
  groups: NbGroup[] = [{ id: 'g-all', name: 'All' }];
  policies: NbPolicy[] = [];
  networks: (NbNetwork & { res: NbResource[]; routers: NbRouter[] })[] = [];
  zones: NbZone[] = [];
  users: NbUser[] = [];
  peers: NbPeerFull[] = [];
  idps: NbIdentityProvider[] = [];
  account: NbAccount = {
    id: 'acct',
    settings: { peer_login_expiration: 86400, peer_login_expiration_enabled: true, groups_propagation_enabled: true, extra: { user_approval_required: true } },
  };
  writes: string[] = [];

  private id(p: string) {
    return `${p}${++this.n}`;
  }
  private w(s: string) {
    this.writes.push(s);
  }

  listGroups = async () => this.groups.map((g) => ({ ...g }));
  createGroup = async (name: string) => {
    this.w(`group+ ${name}`);
    const g = { id: this.id('g'), name };
    this.groups.push(g);
    return g;
  };
  deleteGroup = async (id: string) => {
    const g = this.groups.find((x) => x.id === id)!;
    if (this.users.some((u) => u.auto_groups.includes(id))) throw new Error('group linked to user');
    this.w(`group- ${g.name}`);
    this.groups = this.groups.filter((x) => x.id !== id);
  };
  listPolicies = async () => structuredClone(this.policies);
  createPolicy = async (p: NbPolicy) => {
    this.w(`policy+ ${p.name}`);
    const c = { ...structuredClone(p), id: this.id('p') };
    this.policies.push(c);
    return c;
  };
  updatePolicy = async (id: string, p: NbPolicy) => {
    this.w(`policy~ ${p.name}`);
    this.policies = this.policies.map((x) => (x.id === id ? { ...structuredClone(p), id } : x));
    return p;
  };
  deletePolicy = async (id: string) => {
    this.w(`policy- ${this.policies.find((p) => p.id === id)!.name}`);
    this.policies = this.policies.filter((x) => x.id !== id);
  };
  listNetworks = async () => this.networks.map(({ res: _r, routers: _ro, ...n }) => ({ ...n }));
  createNetwork = async (n: { name: string; description?: string }) => {
    this.w(`network+ ${n.name}`);
    const c = { ...n, id: this.id('n'), res: [], routers: [] };
    this.networks.push(c);
    return { id: c.id, name: c.name };
  };
  deleteNetwork = async (id: string) => {
    this.w(`network- ${this.networks.find((n) => n.id === id)!.name}`);
    this.networks = this.networks.filter((n) => n.id !== id);
  };
  private net(id: string) {
    return this.networks.find((n) => n.id === id)!;
  }
  listResources = async (nid: string) => structuredClone(this.net(nid).res);
  createResource = async (nid: string, r: { name: string; address: string; enabled: boolean; groups: string[] }) => {
    this.w(`resource+ ${r.name} ${r.address}`);
    const c = { id: this.id('r'), name: r.name, address: r.address, enabled: r.enabled, groups: r.groups.map((id) => ({ id })) };
    this.net(nid).res.push(c);
    return c;
  };
  updateResource = async (nid: string, id: string, r: { name: string; address: string; enabled: boolean; groups: string[] }) => {
    this.w(`resource~ ${r.name} ${r.address}`);
    const n = this.net(nid);
    n.res = n.res.map((x) => (x.id === id ? { id, name: r.name, address: r.address, enabled: r.enabled, groups: r.groups.map((g) => ({ id: g })) } : x));
    return n.res.find((x) => x.id === id)!;
  };
  deleteResource = async (nid: string, id: string) => {
    this.w(`resource- ${id}`);
    const n = this.net(nid);
    n.res = n.res.filter((x) => x.id !== id);
  };
  listRouters = async (nid: string) => structuredClone(this.net(nid).routers);
  createRouter = async (nid: string, r: { peer_groups: string[]; masquerade: boolean; metric: number; enabled: boolean }) => {
    this.w(`router+ ${this.net(nid).name}`);
    const c = { id: this.id('rt'), ...r };
    this.net(nid).routers.push(c);
    return c;
  };
  deleteRouter = async () => {};
  listZones = async () => structuredClone(this.zones);
  createZone = async (z: { name: string; domain: string; enabled: boolean; enable_search_domain: boolean; distribution_groups: string[] }) => {
    this.w(`zone+ ${z.domain}`);
    const c = { ...z, id: this.id('z'), records: [] as NbRecord[] };
    this.zones.push(c);
    return structuredClone(c);
  };
  updateZone = async (id: string, z: { name: string; domain: string; enabled: boolean; enable_search_domain: boolean; distribution_groups: string[] }) => {
    this.w(`zone~ ${z.domain}`);
    this.zones = this.zones.map((x) => (x.id === id ? { ...x, ...z } : x));
    return this.zones.find((x) => x.id === id)!;
  };
  deleteZone = async (id: string) => {
    this.w(`zone- ${this.zones.find((z) => z.id === id)!.domain}`);
    this.zones = this.zones.filter((z) => z.id !== id);
  };
  private zone(id: string) {
    return this.zones.find((z) => z.id === id)!;
  }
  createRecord = async (zid: string, r: { name: string; type: string; content: string; ttl: number }) => {
    this.w(`record+ ${r.name} ${r.content}`);
    const c = { ...r, id: this.id('rec') };
    this.zone(zid).records!.push(c);
    return c;
  };
  updateRecord = async (zid: string, id: string, r: { name: string; type: string; content: string; ttl: number }) => {
    this.w(`record~ ${r.name} ${r.content}`);
    const z = this.zone(zid);
    z.records = z.records!.map((x) => (x.id === id ? { ...r, id } : x));
    return { ...r, id };
  };
  deleteRecord = async (zid: string, id: string) => {
    this.w(`record- ${id}`);
    const z = this.zone(zid);
    z.records = z.records!.filter((x) => x.id !== id);
  };
  listUsers = async () => structuredClone(this.users);
  updateUser = async (id: string, u: { role: string; auto_groups: string[]; is_blocked: boolean }) => {
    const cur = this.users.find((x) => x.id === id)!;
    this.w(`user~ ${cur.email} ${u.is_blocked ? 'blocked' : 'active'} [${u.auto_groups.map((g) => this.groups.find((x) => x.id === g)?.name ?? g).join(',')}]`);
    Object.assign(cur, u);
    return cur;
  };
  listPeersFull = async () => structuredClone(this.peers);
  deletePeer = async (id: string) => {
    this.w(`peer- ${this.peers.find((p) => p.id === id)!.name}`);
    this.peers = this.peers.filter((p) => p.id !== id);
  };
  createSetupKey = async () => ({ id: 'k', key: 'KEY' });
  listIdentityProviders = async () => structuredClone(this.idps);
  createIdentityProvider = async (p: { type: 'oidc'; name: string; issuer: string; client_id: string; client_secret: string }) => {
    this.w(`idp+ ${p.name}`);
    const c = { id: this.id('idp'), name: p.name, type: p.type, issuer: p.issuer, client_id: p.client_id };
    this.idps.push(c);
    return c;
  };
  updateIdentityProvider = async (id: string, p: { type: 'oidc'; name: string; issuer: string; client_id: string; client_secret: string }) => {
    this.w(`idp~ ${p.name}`);
    return { id, name: p.name, type: p.type, issuer: p.issuer, client_id: p.client_id };
  };
  getAccount = async () => structuredClone(this.account);
  updateAccountSettings = async (_id: string, settings: NbAccount['settings']) => {
    this.w('account~');
    this.account.settings = structuredClone(settings);
    return this.account;
  };
}

function intent(vip = '10.201.1.2'): PeopleAccessIntent {
  return {
    cluster: 'lon',
    stacks: [
      {
        stackId: 's1',
        stackName: 'storefront',
        ruleAccess: true,
        services: [{ name: 'db', vip, ports: [{ port: 5432, proto: 'tcp' }] }],
        grants: [],
      },
    ],
  };
}

describe('bootstrapControlPlane', () => {
  test('deletes the Default All↔All policy, creates nodes↔nodes, sets people settings; then idempotent', async () => {
    const nb = new FakeNetbird();
    nb.policies.push({
      id: 'p-def',
      name: 'Default',
      enabled: true,
      rules: [{ name: 'Default', enabled: true, action: 'accept', bidirectional: true, protocol: 'all', sources: [{ id: 'g-all' }], destinations: [{ id: 'g-all' }] }],
    });
    // An operator's own policy survives.
    nb.policies.push({ id: 'p-mine', name: 'office', enabled: true, rules: [] });
    await bootstrapControlPlane(nb, { cluster: 'lon' });
    expect(nb.writes).toEqual(['policy- Default', 'group+ swarmy:lon:nodes', 'policy+ swarmy-lon-nodes', 'account~']);
    expect(nb.account.settings.peer_login_expiration).toBe(43200);
    expect(nb.account.settings.extra?.user_approval_required).toBe(false);
    expect(nb.policies.map((p) => p.name)).toEqual(['office', 'swarmy-lon-nodes']);
    nb.writes = [];
    await bootstrapControlPlane(nb, { cluster: 'lon' });
    expect(nb.writes).toEqual([]);
  });

  test('a policy called Default that is NOT All↔All is left alone', async () => {
    const nb = new FakeNetbird();
    nb.groups.push({ id: 'g-x', name: 'x' });
    nb.policies.push({
      id: 'p-def',
      name: 'Default',
      enabled: true,
      rules: [{ name: 'Default', enabled: true, action: 'accept', bidirectional: true, protocol: 'all', sources: [{ id: 'g-x' }], destinations: [{ id: 'g-all' }] }],
    });
    await bootstrapControlPlane(nb, { cluster: 'lon' });
    expect(nb.policies.some((p) => p.name === 'Default')).toBe(true);
  });
});

describe('applyPeopleAccessPlan', () => {
  test('first sync creates everything; second sync writes nothing', async () => {
    const nb = new FakeNetbird();
    await applyPeopleAccessPlan(nb, buildPeopleAccessPlan(intent()));
    expect(nb.writes).toEqual([
      'group+ swarmy:lon:access:s1',
      'group+ swarmy:lon:res:s1',
      'group+ swarmy:lon:router:s1',
      'network+ swarmy-lon-s1',
      'resource+ db 10.201.1.2/32',
      'router+ swarmy-lon-s1',
      'policy+ swarmy-lon-s1-db',
      'zone+ storefront.lon.swarmy.internal',
      'record+ db.storefront.lon.swarmy.internal 10.201.1.2',
    ]);
    const pol = nb.policies[0]!;
    expect(pol.rules[0]!.ports).toEqual(['5432']);
    expect(pol.rules[0]!.bidirectional).toBe(false);
    expect(pol.rules[0]!.destinationResource).toEqual({ id: nb.networks[0]!.res[0]!.id, type: 'host' });
    nb.writes = [];
    await applyPeopleAccessPlan(nb, buildPeopleAccessPlan(intent()));
    expect(nb.writes).toEqual([]);
  });

  test('a redeploy that moves the VIP updates the resource and the record only', async () => {
    const nb = new FakeNetbird();
    await applyPeopleAccessPlan(nb, buildPeopleAccessPlan(intent()));
    nb.writes = [];
    await applyPeopleAccessPlan(nb, buildPeopleAccessPlan(intent('10.201.1.9')));
    expect(nb.writes).toEqual(['resource~ db 10.201.1.9/32', 'record~ db.storefront.lon.swarmy.internal 10.201.1.9']);
  });

  test('revoking the last access removes the zone, policy and network; groups prune after users', async () => {
    const nb = new FakeNetbird();
    const plan = buildPeopleAccessPlan(intent());
    await applyPeopleAccessPlan(nb, plan);
    nb.users.push({ id: 'u1', email: 'sam@acme.dev', name: 'Sam', role: 'user', auto_groups: [nb.groups.find((g) => g.name === 'swarmy:lon:access:s1')!.id], is_blocked: false });
    const off = intent();
    off.stacks[0]!.ruleAccess = false;
    const empty = buildPeopleAccessPlan(off);
    nb.writes = [];
    await applyPeopleAccessPlan(nb, empty);
    expect(nb.writes).toEqual(['zone- storefront.lon.swarmy.internal', 'policy- swarmy-lon-s1-db', 'network- swarmy-lon-s1']);
    // The group is still on Sam: prune can't drop it yet…
    nb.writes = [];
    await pruneGroups(nb, empty);
    expect(nb.writes).toEqual(['group- swarmy:lon:res:s1', 'group- swarmy:lon:router:s1']);
    // …until user sync takes it off him.
    await applyUserSync(nb, { cluster: 'lon', people: [{ userId: 'sam', email: 'sam@acme.dev', groups: [] }] });
    nb.writes = [];
    await pruneGroups(nb, empty);
    expect(nb.writes).toEqual(['group- swarmy:lon:access:s1']);
  });

  test('never touches objects outside the cluster namespace', async () => {
    const nb = new FakeNetbird();
    nb.groups.push({ id: 'g-other', name: 'swarmy:nyc:access:s1' }, { id: 'g-ops', name: 'ops' });
    nb.policies.push({ id: 'p-nyc', name: 'swarmy-nyc-s1-db', enabled: true, rules: [] }, { id: 'p-ops', name: 'ops', enabled: true, rules: [] });
    nb.zones.push({ id: 'z-ops', name: 'ops', domain: 'ops.internal', enabled: true, enable_search_domain: false, distribution_groups: [], records: [] });
    nb.networks.push({ id: 'n-ops', name: 'ops-net', res: [], routers: [] });
    const empty = buildPeopleAccessPlan({ cluster: 'lon', stacks: [] });
    await applyPeopleAccessPlan(nb, empty);
    await pruneGroups(nb, empty);
    expect(nb.writes).toEqual([]);
  });
});

describe('applyUserSync', () => {
  test('grants groups by email, blocks leavers and deletes their peers, spares owner + service users', async () => {
    const nb = new FakeNetbird();
    nb.users.push(
      { id: 'u-own', email: 'owner@swarmy.local', name: 'break-glass', role: 'owner', auto_groups: [], is_blocked: false, idp_id: 'local' },
      { id: 'u-svc', email: '', name: 'swarmy-controller', role: 'admin', auto_groups: [], is_blocked: false, is_service_user: true },
      { id: 'u-sam', email: 'sam@acme.dev', name: 'Sam', role: 'user', auto_groups: [], is_blocked: false },
      { id: 'u-eve', email: 'eve@acme.dev', name: 'Eve', role: 'user', auto_groups: [], is_blocked: false },
    );
    nb.peers.push(
      { id: 'pe1', name: 'eves-mac', ip: '100.80.0.9', connected: true, user_id: 'u-eve' },
      { id: 'ps1', name: 'sams-mac', ip: '100.80.0.8', connected: true, user_id: 'u-sam' },
    );
    await applyUserSync(nb, { cluster: 'lon', people: [{ userId: 'sam', email: 'sam@acme.dev', groups: ['swarmy:lon:access:s1'] }] });
    expect(nb.writes).toEqual([
      'group+ swarmy:lon:access:s1',
      'user~ eve@acme.dev blocked []',
      'peer- eves-mac',
      'user~ sam@acme.dev active [swarmy:lon:access:s1]',
    ]);
    nb.writes = [];
    await applyUserSync(nb, { cluster: 'lon', people: [{ userId: 'sam', email: 'sam@acme.dev', groups: ['swarmy:lon:access:s1'] }] });
    expect(nb.writes).toEqual([]);
  });
});

describe('ensureSwarmyConnector + listPeoplePeers', () => {
  test('registers once, then finds it', async () => {
    const nb = new FakeNetbird();
    const a = await ensureSwarmyConnector(nb, { issuer: 'https://s/api/auth', clientId: 'swarmy-mesh', clientSecret: 'sec' });
    const b = await ensureSwarmyConnector(nb, { issuer: 'https://s/api/auth', clientId: 'swarmy-mesh' });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(nb.writes).toEqual(['idp+ swarmy']);
  });

  test('people peers only (not server or router peers), with their swarmy groups', async () => {
    const nb = new FakeNetbird();
    nb.users.push(
      { id: 'u-svc', email: '', name: 'svc', role: 'admin', auto_groups: [], is_blocked: false, is_service_user: true },
      { id: 'u-sam', email: 'sam@acme.dev', name: 'Sam', role: 'user', auto_groups: [], is_blocked: false },
    );
    nb.peers.push(
      { id: 'n1', name: 'lon-1', ip: '100.80.0.1', connected: true, user_id: 'u-svc', groups: [{ id: 'g', name: 'swarmy:lon:nodes' }] },
      { id: 'p1', name: 'sams-mac', hostname: 'Sams-MacBook', ip: '100.80.0.8', connected: true, user_id: 'u-sam', os: 'darwin', groups: [{ id: 'a', name: 'swarmy:lon:access:s1' }, { id: 'b', name: 'All' }] },
    );
    const people = await listPeoplePeers(nb, 'lon');
    expect(people).toEqual([
      {
        peerId: 'p1',
        userId: 'u-sam',
        email: 'sam@acme.dev',
        name: 'Sam',
        device: 'Sams-MacBook',
        os: 'darwin',
        version: undefined,
        meshIp: '100.80.0.8',
        connected: true,
        lastSeen: undefined,
        loginExpired: false,
        groups: ['swarmy:lon:access:s1'],
      },
    ]);
  });
});
