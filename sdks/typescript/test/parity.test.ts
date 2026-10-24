import { describe, expect, it } from 'bun:test';
import { SwarmyClient } from '../src/index.js';
import type { FetchLike } from '../src/index.js';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** A client whose fetch records each call and answers `body` as JSON. */
function setup(body: unknown, status = 200) {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { client: new SwarmyClient({ endpoint: 'http://x', apiKey: 'swk_y', fetch }), calls };
}

interface Case {
  /** The method under test, as `resource.method`. */
  name: string;
  call: (c: SwarmyClient) => Promise<unknown>;
  response: unknown;
  status?: number;
  /** `METHOD URL` the call must send. */
  request: string;
  /** The JSON body it must send (omitted = no body). */
  body?: unknown;
  /** One decoded field of the response. */
  check: (out: any) => unknown;
  want: unknown;
}

const B = 'http://x/api/v1';
const node = { id: 'n 1', availability: 'drain' };
const status = {
  host: 'shop.example.com', state: 'active', reason: '', warnings: [], gated: false, verified_at: null,
  verified_manually: false, last_checked_at: null, next_check_at: null, dns: null, certificate: null,
};
const detail = { ...status, guidance: { mode: 'records', summary: 'Point A at the edge', records: [], alternatives: [] }, companion: null };
const settings = { org_id: 'o1', driver: 'caddy', enabled: false, topology: 'controller', controller_image: null };
const conn = { id: 'gc1', kind: 'gitlab', display_name: 'GitLab', base_url: 'https://gitlab.com', account: null, status: 'ok', repo_count: 0 };
const repo = { id: 'r1', url: 'https://x.dev/a.git', branch: 'main', config_path: 'swarmy.yaml' };
const cred = { id: 'rc1', prefix: 'ghcr.io/acme', provider: 'ghcr', username: 'bot', label: null };
const list = (data: unknown[]) => ({ data, next_cursor: null });

const cases: Case[] = [
  // nodes
  { name: 'nodes.remove', call: (c) => c.nodes.remove('n 1'), response: { id: 'n 1', removed: true },
    request: `DELETE ${B}/nodes/n%201`, check: (o) => o.removed, want: true },
  { name: 'nodes.drain', call: (c) => c.nodes.drain('n 1'), response: node,
    request: `POST ${B}/nodes/n%201/drain`, check: (o) => o.availability, want: 'drain' },
  { name: 'nodes.uncordon', call: (c) => c.nodes.uncordon('n1'), response: { id: 'n1', availability: 'active' },
    request: `POST ${B}/nodes/n1/uncordon`, check: (o) => o.availability, want: 'active' },
  { name: 'nodes.setLabels', call: (c) => c.nodes.setLabels('n1', { zone: 'eu' }), response: { id: 'n1', labels: { zone: 'eu' } },
    request: `PUT ${B}/nodes/n1/labels`, body: { labels: { zone: 'eu' } }, check: (o) => o.labels.zone, want: 'eu' },
  // ingress
  { name: 'ingress.updateDomain', call: (c) => c.ingress.updateDomain('d 1', { www: null }), response: { id: 'd 1', host: 'shop.example.com', www: null },
    request: `PATCH ${B}/ingress/domains/d%201`, body: { www: null }, check: (o) => o.host, want: 'shop.example.com' },
  { name: 'ingress.domainStatus', call: (c) => c.ingress.domainStatus('d1'), response: detail,
    request: `GET ${B}/ingress/domains/d1/status`, check: (o) => o.guidance.mode, want: 'records' },
  { name: 'ingress.verifyDomain', call: (c) => c.ingress.verifyDomain('d1'), response: detail,
    request: `POST ${B}/ingress/domains/d1/verify`, check: (o) => o.state, want: 'active' },
  { name: 'ingress.settings', call: (c) => c.ingress.settings(), response: settings,
    request: `GET ${B}/ingress/settings`, check: (o) => o.driver, want: 'caddy' },
  { name: 'ingress.updateSettings', call: (c) => c.ingress.updateSettings({ enabled: false, tls: { on_demand: false }, tunnel: null }), response: settings,
    request: `PUT ${B}/ingress/settings`, body: { enabled: false, tls: { on_demand: false }, tunnel: null }, check: (o) => o.enabled, want: false },
  // apps
  { name: 'apps.confirm', call: (c) => c.apps.confirm('p 1', ['resource.delete:files']), response: { status: 'applied', confirmed: ['resource.delete:files'] },
    request: `POST ${B}/apps/plans/p%201/confirm`, body: { action_ids: ['resource.delete:files'] }, check: (o) => o.status, want: 'applied' },
  { name: 'apps.setRequireApproval', call: (c) => c.apps.setRequireApproval('gr1', false), response: { repo_id: 'gr1', require_approval: false },
    request: `PUT ${B}/apps/gr1/require-approval`, body: { require_approval: false }, check: (o) => o.require_approval, want: false },
  { name: 'apps.drift', call: (c) => c.apps.drift('gr1'), response: list([{ environment: 'production' }]),
    request: `GET ${B}/apps/gr1/drift`, check: (o) => o.data[0].environment, want: 'production' },
  { name: 'apps.setEnforceDrift', call: (c) => c.apps.setEnforceDrift('gr1', false), response: { repo_id: 'gr1', enforce_drift: false },
    request: `PUT ${B}/apps/gr1/enforce-drift`, body: { enforce_drift: false }, check: (o) => o.enforce_drift, want: false },
  { name: 'apps.purgeData', call: (c) => c.apps.purgeData('gr1', 'prod uction', { resource: 'db', confirm: 'shop/db' }),
    response: { stack: 'shop', resource: 'db', volumes: ['v1'], nodes: 2 },
    request: `POST ${B}/apps/gr1/environments/prod%20uction/purge`, body: { resource: 'db', confirm: 'shop/db' }, check: (o) => o.nodes, want: 2 },
  { name: 'apps.promote', call: (c) => c.apps.promote('gr1', 'staging'), response: { plan_id: 'p2', status: 'applied' },
    request: `POST ${B}/apps/gr1/promote`, body: { from: 'staging' }, check: (o) => o.plan_id, want: 'p2' },
  // deployments
  { name: 'deployments.events', call: (c) => c.deployments.events('dep 1'), response: { deploy_id: 'dep 1', stack: 'shop', started_at: 1, done: true, data: [] },
    request: `GET ${B}/deploys/dep%201/events`, check: (o) => o.done, want: true },
  // api keys
  { name: 'apiKeys.list', call: (c) => c.apiKeys.list(), response: list([{ id: 'k1', prefix: 'ab12' }]),
    request: `GET ${B}/api-keys`, check: (o) => o.data[0].prefix, want: 'ab12' },
  { name: 'apiKeys.create', call: (c) => c.apiKeys.create({ name: 'ci', preset: 'deploy', stack_names: null }), response: { id: 'k1', name: 'ci', key: 'swk_ab12_x' }, status: 201,
    request: `POST ${B}/api-keys`, body: { name: 'ci', preset: 'deploy', stack_names: null }, check: (o) => o.key, want: 'swk_ab12_x' },
  { name: 'apiKeys.revoke', call: (c) => c.apiKeys.revoke('k 1'), response: { id: 'k 1', revoked: true },
    request: `DELETE ${B}/api-keys/k%201`, check: (o) => o.revoked, want: true },
  // dns
  { name: 'dns.listZones', call: (c) => c.dns.listZones(), response: list([{ id: 'z1', zone: 'example.com' }]),
    request: `GET ${B}/dns/zones`, check: (o) => o.data[0].zone, want: 'example.com' },
  { name: 'dns.createZone', call: (c) => c.dns.createZone({ zone: 'example.com', mode: 'swarmy-ns' }), response: { id: 'z1', zone: 'example.com' },
    request: `POST ${B}/dns/zones`, body: { zone: 'example.com', mode: 'swarmy-ns' }, check: (o) => o.id, want: 'z1' },
  { name: 'dns.removeZone', call: (c) => c.dns.removeZone('z 1'), response: { id: 'z 1', removed: true },
    request: `DELETE ${B}/dns/zones/z%201`, check: (o) => o.removed, want: true },
  { name: 'dns.delegation', call: (c) => c.dns.delegation('z1'), response: { zone: 'example.com', delegated: true, public_ns: [], nameservers: [] },
    request: `GET ${B}/dns/zones/z1/delegation`, check: (o) => o.delegated, want: true },
  { name: 'dns.listRecords', call: (c) => c.dns.listRecords('z1'), response: list([{ id: 'rec1', type: 'MX' }]),
    request: `GET ${B}/dns/zones/z1/records`, check: (o) => o.data[0].type, want: 'MX' },
  { name: 'dns.upsertRecord', call: (c) => c.dns.upsertRecord('z1', { name: '@', type: 'MX', value: 'mx.example.com', priority: 0 }),
    response: { id: 'rec1', zone_id: 'z1', name: '@', type: 'MX', value: 'mx.example.com', ttl: null, priority: 0 },
    request: `POST ${B}/dns/zones/z1/records`, body: { name: '@', type: 'MX', value: 'mx.example.com', priority: 0 }, check: (o) => o.priority, want: 0 },
  { name: 'dns.removeRecord', call: (c) => c.dns.removeRecord('rec 1'), response: { id: 'rec 1', removed: true },
    request: `DELETE ${B}/dns/records/rec%201`, check: (o) => o.removed, want: true },
  // backups
  { name: 'backups.listTargets', call: (c) => c.backups.listTargets(), response: list([{ id: 't1', name: 'offsite' }]),
    request: `GET ${B}/backup-targets`, check: (o) => o.data[0].name, want: 'offsite' },
  { name: 'backups.addTarget', call: (c) => c.backups.addTarget({ name: 'offsite', kind: 's3', bucket: 'bk' }), response: { id: 't1', name: 'offsite' }, status: 201,
    request: `POST ${B}/backup-targets`, body: { name: 'offsite', kind: 's3', bucket: 'bk' }, check: (o) => o.id, want: 't1' },
  { name: 'backups.removeTarget', call: (c) => c.backups.removeTarget('t 1'), response: { id: 't 1', removed: true },
    request: `DELETE ${B}/backup-targets/t%201`, check: (o) => o.removed, want: true },
  { name: 'backups.listSnapshots', call: (c) => c.backups.listSnapshots({ volume: 'shop_data', targetId: 't1' }), response: list([{ id: 's1' }]),
    request: `GET ${B}/snapshots?volume=shop_data&target_id=t1`, check: (o) => o.data[0].id, want: 's1' },
  { name: 'backups.backupVolume', call: (c) => c.backups.backupVolume({ target_id: 't1', volume: 'shop_data' }), response: { snapshot_id: 's2' }, status: 201,
    request: `POST ${B}/snapshots`, body: { target_id: 't1', volume: 'shop_data' }, check: (o) => o.snapshot_id, want: 's2' },
  { name: 'backups.restoreSnapshot', call: (c) => c.backups.restoreSnapshot({ snapshot_id: 's1' }), response: { target_volume: 'shop_data', bytes_restored: '42' },
    request: `POST ${B}/snapshots/restore`, body: { snapshot_id: 's1' }, check: (o) => o.bytes_restored, want: '42' },
  // volumes
  { name: 'volumes.list', call: (c) => c.volumes.list(), response: list([{ id: 'v1', name: 'pg' }]),
    request: `GET ${B}/volumes`, check: (o) => o.data[0].name, want: 'pg' },
  { name: 'volumes.register', call: (c) => c.volumes.register({ name: 'pg', csi_driver: 'local', capacity_bytes: 0 }), response: { id: 'v1', name: 'pg' }, status: 201,
    request: `POST ${B}/volumes`, body: { name: 'pg', csi_driver: 'local', capacity_bytes: 0 }, check: (o) => o.id, want: 'v1' },
  { name: 'volumes.remove', call: (c) => c.volumes.remove('v 1'), response: { id: 'v 1', removed: true },
    request: `DELETE ${B}/volumes/v%201`, check: (o) => o.removed, want: true },
  // registry credentials
  { name: 'registryCredentials.list', call: (c) => c.registryCredentials.list(), response: list([cred]),
    request: `GET ${B}/registry-credentials`, check: (o) => o.data[0].prefix, want: 'ghcr.io/acme' },
  { name: 'registryCredentials.create', call: (c) => c.registryCredentials.create({ prefix: 'ghcr.io/acme', username: 'bot', secret: 's3cret' }), response: cred, status: 201,
    request: `POST ${B}/registry-credentials`, body: { prefix: 'ghcr.io/acme', username: 'bot', secret: 's3cret' }, check: (o) => o.id, want: 'rc1' },
  { name: 'registryCredentials.update', call: (c) => c.registryCredentials.update('rc 1', { label: null }), response: cred,
    request: `PATCH ${B}/registry-credentials/rc%201`, body: { label: null }, check: (o) => o.label, want: null },
  { name: 'registryCredentials.remove', call: (c) => c.registryCredentials.remove('rc1'), response: { ok: true },
    request: `DELETE ${B}/registry-credentials/rc1`, check: (o) => o.ok, want: true },
  { name: 'registryCredentials.test', call: (c) => c.registryCredentials.test('rc1', { image: 'ghcr.io/acme/web:1' }), response: { ok: true, status: 'ok', message: 'pulled' },
    request: `POST ${B}/registry-credentials/rc1/test`, body: { image: 'ghcr.io/acme/web:1' }, check: (o) => o.message, want: 'pulled' },
  // git
  { name: 'git.listConnections', call: (c) => c.git.listConnections(), response: list([conn]),
    request: `GET ${B}/git/connections`, check: (o) => o.data[0].kind, want: 'gitlab' },
  { name: 'git.getConnection', call: (c) => c.git.getConnection('gc 1'), response: conn,
    request: `GET ${B}/git/connections/gc%201`, check: (o) => o.id, want: 'gc1' },
  { name: 'git.createConnection', call: (c) => c.git.createConnection({ kind: 'gitlab', token: 'glpat-x' }), response: conn, status: 201,
    request: `POST ${B}/git/connections`, body: { kind: 'gitlab', token: 'glpat-x' }, check: (o) => o.display_name, want: 'GitLab' },
  { name: 'git.removeConnection', call: (c) => c.git.removeConnection('gc1'), response: { ok: true },
    request: `DELETE ${B}/git/connections/gc1`, check: (o) => o.ok, want: true },
  { name: 'git.listProviderRepos', call: (c) => c.git.listProviderRepos('gc1', { search: 'web' }), response: list([{ id: '7', full_name: 'acme/web' }]),
    request: `GET ${B}/git/connections/gc1/repos?search=web`, check: (o) => o.data[0].full_name, want: 'acme/web' },
  { name: 'git.listProviderBranches', call: (c) => c.git.listProviderBranches('gc1', 'acme/web'), response: list([{ name: 'main', sha: 'abc' }]),
    request: `GET ${B}/git/connections/gc1/branches?repo=acme%2Fweb`, check: (o) => o.data[0].name, want: 'main' },
  { name: 'git.listRepos', call: (c) => c.git.listRepos(), response: list([repo]),
    request: `GET ${B}/git/repos`, check: (o) => o.data[0].branch, want: 'main' },
  { name: 'git.getRepo', call: (c) => c.git.getRepo('r 1'), response: repo,
    request: `GET ${B}/git/repos/r%201`, check: (o) => o.url, want: 'https://x.dev/a.git' },
  { name: 'git.linkRepo', call: (c) => c.git.linkRepo({ url: 'https://x.dev/a.git', branch: 'main', deploy_key: false }),
    response: { ...repo, full_name: null, webhook: null, deploy_key_public: null }, status: 201,
    request: `POST ${B}/git/repos`, body: { url: 'https://x.dev/a.git', branch: 'main', deploy_key: false }, check: (o) => o.webhook, want: null },
  { name: 'git.updateRepo', call: (c) => c.git.updateRepo('r1', { branch: 'release' }), response: { ...repo, branch: 'release' },
    request: `PATCH ${B}/git/repos/r1`, body: { branch: 'release' }, check: (o) => o.branch, want: 'release' },
  { name: 'git.removeRepo', call: (c) => c.git.removeRepo('r1'), response: { ok: true },
    request: `DELETE ${B}/git/repos/r1`, check: (o) => o.ok, want: true },
  // client-level
  { name: 'notify', call: (c) => c.notify({ to: 'ops@example.com', subject: 'Hi', body: 'hello' }), response: { queued: true, to: 'ops@example.com' }, status: 202,
    request: `POST ${B}/notify`, body: { to: 'ops@example.com', subject: 'Hi', body: 'hello' }, check: (o) => o.queued, want: true },
];

describe('every REST route has a TS method (parity)', () => {
  for (const t of cases) {
    it(t.name, async () => {
      const { client, calls } = setup(t.response, t.status);
      const out = await t.call(client);
      expect(calls).toHaveLength(1);
      expect(`${calls[0]!.init!.method} ${calls[0]!.url}`).toBe(t.request);
      const sent = calls[0]!.init!.body;
      if (t.body === undefined) expect(sent).toBeUndefined();
      else expect(JSON.parse(sent as string)).toEqual(t.body);
      expect(t.check(out)).toEqual(t.want);
    });
  }
});

describe('audit.export', () => {
  it('reads the body as text and the row-count headers', async () => {
    const calls: Captured[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response('at,actor\n2026-10-01,u1\n', {
        status: 200,
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'X-Swarmy-Row-Count': '1', 'X-Swarmy-Truncated': 'true' },
      });
    };
    const client = new SwarmyClient({ endpoint: 'http://x', apiKey: 'swk_y', fetch });

    const out = await client.audit.export({ actorType: 'apikey', action: 'secrets.', from: '2026-10-01', format: 'csv' });

    expect(`${calls[0]!.init!.method} ${calls[0]!.url}`).toBe(
      `GET ${B}/audit/export?actor_type=apikey&action=secrets.&from=2026-10-01&format=csv`,
    );
    expect((calls[0]!.init!.headers as Record<string, string>).Accept).toContain('text/csv');
    expect(out).toEqual({ content: 'at,actor\n2026-10-01,u1\n', contentType: 'text/csv; charset=utf-8', rowCount: 1, truncated: true });
  });
});
