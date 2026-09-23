import { beforeEach, describe, expect, it } from 'bun:test';
import type { DnsSnapshotBundle, SwarmServiceInfo } from '@swarmy/core/protocol';
import { ControllerToAgentMessage } from '@swarmy/core/protocol';
import { toServiceCreateOptions } from '@swarmy/core/docker';
import type { OrgContext } from '../context';
import {
  DNS_ADMIN_PORT,
  DNS_HOST_NETWORK,
  DNS_SERVICE,
  dnsAdminToken,
  dnsServiceSpec,
  ensureDnsService,
  parseDnsOrgSettings,
} from './dns-deploy.service';
import { dnsAdminUrl, pushDnsBundle } from './dns-push.service';
import {
  DNS_START_GRACE_MS,
  deriveDnsRuntime,
  lastDnsPushes,
  resetDnsRuntimeRecords,
  type DnsRuntimeInput,
} from './dns-runtime';
import { dnsRuntimeStatus, pushSummary } from './geodns.service';

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-dns';

const CMD_ID = '00000000-0000-4000-8000-000000000001';

describe('dnsServiceSpec — host network, no published ports', () => {
  const spec = dnsServiceSpec(parseDnsOrgSettings({}));

  it('attaches to swarm\'s predefined host network and publishes NOTHING', () => {
    expect(spec.networks).toEqual([DNS_HOST_NETWORK]);
    expect(DNS_HOST_NETWORK).toBe('host');
    // Explicitly empty (not omitted) so an update clears the old 53/53535 host ports.
    expect(spec.ports).toEqual([]);
  });

  it('stays a global service on ingress+outlet nodes with the admin port pinned in env', () => {
    expect(spec.mode).toEqual({ global: {} });
    expect(spec.placement?.constraints).toEqual([
      'node.labels.swarmy.node.ingress == true',
      'node.labels.swarmy.node.outlet == true',
    ]);
    expect(spec.env?.SWARMY_DNS_ADMIN_PORT).toBe(String(DNS_ADMIN_PORT));
    // No listen override: the server auto-binds per address (never 0.0.0.0).
    expect(spec.env?.SWARMY_DNS_LISTEN).toBeUndefined();
    expect(spec.env?.SWARMY_DNS_HOST).toBeUndefined();
  });

  it('survives the wire and maps to TaskTemplate.Networks=host + empty EndpointSpec ports', () => {
    const wire = JSON.parse(JSON.stringify({ type: 'deployService', payload: { commandId: CMD_ID, spec } }));
    const parsed = ControllerToAgentMessage.parse(wire);
    if (parsed.type !== 'deployService') throw new Error('wrong type');
    const opts = toServiceCreateOptions(parsed.payload.spec) as unknown as {
      TaskTemplate: { Networks?: Array<{ Target: string }> };
      EndpointSpec?: { Ports: unknown[] };
    };
    expect(opts.TaskTemplate.Networks).toEqual([{ Target: 'host' }]);
    expect(opts.EndpointSpec).toEqual({ Ports: [] });
  });
});

// ── fake hub: deploy + push paths ──

function fakeCtx(opts: { services?: SwarmServiceInfo[]; failNodes?: Record<string, string>; dnsRunning?: Record<string, boolean> } = {}) {
  const sent: Array<{ nodeId: string; cmd: string; payload: Record<string, unknown> }> = [];
  const hub = {
    isOnline: () => true,
    managerNode: () => 'n1',
    nodesByRole: () => ['n1', 'n2'],
    nodeInfoFor: (id: string) => ({ hostname: `host-${id}`, labels: {} }),
    ingressStatusFor: (id: string) =>
      opts.dnsRunning && id in opts.dnsRunning
        ? { caddyRunning: true, dnsRunning: opts.dnsRunning[id]!, sampledAt: 0 }
        : undefined,
    liveInventory: () => ({ services: opts.services ?? [], containers: [] }),
    dispatch: async (nodeId: string, cmd: string, payload: Record<string, unknown>) => {
      sent.push({ nodeId, cmd, payload });
      const err = opts.failNodes?.[nodeId];
      if (err) throw new Error(err);
      return { applied: true, version: 1, zones: 1 };
    },
  };
  const ctx = { db: {}, hub, activeOrgId: 'org_dns' } as unknown as OrgContext;
  return { ctx, sent };
}

const bundle = { version: 5, generatedAt: new Date(0).toISOString(), zones: [] } as unknown as DnsSnapshotBundle;

describe('push path (controller → agent dns.apply → local admin API)', () => {
  beforeEach(() => resetDnsRuntimeRecords());

  it('targets the node-local loopback admin API with the derived bearer token', async () => {
    const { ctx, sent } = fakeCtx();
    const r = await pushDnsBundle(ctx, bundle);
    expect(r.pushed.sort()).toEqual(['n1', 'n2']);
    expect(sent.map((s) => s.cmd)).toEqual(['dns.apply', 'dns.apply']);
    for (const s of sent) {
      expect(s.payload.adminUrl).toBe(`http://127.0.0.1:${DNS_ADMIN_PORT}`);
      expect(s.payload.adminToken).toBe(dnsAdminToken('org_dns'));
    }
    expect(dnsAdminUrl()).toBe('http://127.0.0.1:53535');
    // the agent handler's loopback check keys off this exact host
    expect(new URL(dnsAdminUrl()).hostname).toBe('127.0.0.1');
  });

  it('records per-node failures so getConfig/applyNow can say WHY', async () => {
    const { ctx } = fakeCtx({ failNodes: { n2: 'applyDns failed: http://127.0.0.1:53535/v1/snapshot: Unable to connect' } });
    const r = await pushDnsBundle(ctx, bundle);
    expect(r.failed).toEqual([{ nodeId: 'n2', error: 'applyDns failed: http://127.0.0.1:53535/v1/snapshot: Unable to connect' }]);
    const recs = lastDnsPushes('org_dns');
    expect(recs.get('n1')?.ok).toBe(true);
    expect(recs.get('n2')?.error).toContain('Unable to connect');
    expect(pushSummary(r, (id) => `host-${id}`)).toBe(
      'pushed 0 zone(s) to 1 node(s), 1 failed (host-n2: applyDns failed: http://127.0.0.1:53535/v1/snapshot: Unable to connect)',
    );
  });

  it('ensureDnsService deploys the host-network spec', async () => {
    const { ctx, sent } = fakeCtx();
    await ensureDnsService(ctx, parseDnsOrgSettings({}));
    const deploy = sent.find((s) => s.cmd === 'service.deploy');
    const spec = deploy?.payload.spec as { name: string; networks: string[]; ports: unknown[] };
    expect(spec.name).toBe(DNS_SERVICE);
    expect(spec.networks).toEqual(['host']);
    expect(spec.ports).toEqual([]);
  });
});

// ── runtime status ──

const NOW = 10_000_000;
const nodes = [
  { nodeId: 'n1', hostname: 'ams-1', dnsRunning: true as boolean | null },
  { nodeId: 'n2', hostname: 'fra-1', dnsRunning: true as boolean | null },
];
const input = (over: Partial<DnsRuntimeInput> = {}): DnsRuntimeInput => ({
  enabled: true,
  service: { runningTasks: 2, updatedAt: NOW - DNS_START_GRACE_MS * 2, recentFailures: 0, starting: false },
  nodes,
  pushes: new Map(),
  now: NOW,
  ...over,
});
const BIND_ERR = 'failed to bind host port 0.0.0.0:53/tcp: address already in use';

describe('deriveDnsRuntime', () => {
  it('surfaces the task error instead of a silent "enabled" when every task fails', () => {
    const r = deriveDnsRuntime(
      input({
        service: { runningTasks: 0, updatedAt: NOW - 30_000, recentFailures: 6, lastError: BIND_ERR, lastErrorAt: NOW - 1000, starting: false },
        nodes: nodes.map((n) => ({ ...n, dnsRunning: false })),
      }),
    );
    expect(r.state).toBe('down');
    expect(r.serving).toBe(false);
    expect(r.taskError).toBe(BIND_ERR);
    expect(r.message).toContain(BIND_ERR);
  });

  it('ignores task errors from before the current spec (fixed rollout)', () => {
    const r = deriveDnsRuntime(
      input({
        service: { runningTasks: 2, updatedAt: NOW - 60_000, recentFailures: 3, lastError: BIND_ERR, lastErrorAt: NOW - 120_000, starting: false },
      }),
    );
    expect(r.taskError).toBeNull();
    expect(r.state).toBe('serving');
    expect(r.message).toBe('swarmy-dns is answering on ams-1, fra-1.');
  });

  it('deploying inside the grace window when there is no error yet', () => {
    const r = deriveDnsRuntime(
      input({ service: { runningTasks: 0, updatedAt: NOW - 10_000, recentFailures: 0, starting: true } }),
    );
    expect(r.state).toBe('deploying');
  });

  it('degraded names the nodes without a task, and push failures with their reason', () => {
    const partial = deriveDnsRuntime(
      input({
        service: { runningTasks: 1, updatedAt: NOW - 30_000, recentFailures: 1, lastError: BIND_ERR, lastErrorAt: NOW, starting: false },
        nodes: [nodes[0]!, { ...nodes[1]!, dnsRunning: false }],
      }),
    );
    expect(partial.state).toBe('degraded');
    expect(partial.message).toContain('1 of 2');
    expect(partial.message).toContain('fra-1');
    expect(partial.message).toContain(BIND_ERR);

    const pushFail = deriveDnsRuntime(
      input({ pushes: new Map([['n2', { ok: false, at: NOW, error: 'swarmy-dns admin 401: unauthorized' }]]) }),
    );
    expect(pushFail.state).toBe('degraded');
    expect(pushFail.message).toContain('fra-1: swarmy-dns admin 401: unauthorized');
    expect(pushFail.nodes[1]?.lastPush?.error).toBe('swarmy-dns admin 401: unauthorized');
  });

  it('paused when off; down with the deploy error when the service never landed; down with no DNS nodes', () => {
    expect(deriveDnsRuntime(input({ enabled: false })).state).toBe('paused');
    const d = deriveDnsRuntime(input({ service: undefined, lastDeploy: { ok: false, at: NOW, message: 'secret not found: swarmy-dns-admin' } }));
    expect(d.state).toBe('down');
    expect(d.deployError).toBe('secret not found: swarmy-dns-admin');
    expect(d.message).toContain('secret not found');
    expect(deriveDnsRuntime(input({ nodes: [] })).message).toContain('ingress + outlet');
  });
});

describe('dnsRuntimeStatus over the hub', () => {
  beforeEach(() => resetDnsRuntimeRecords());

  it('reads the live swarmy-dns service taskHealth + per-node dnsRunning', () => {
    const svc = {
      id: 's1', name: DNS_SERVICE, image: 'x', mode: 'global', runningReplicas: 0, updatedAt: Date.now() - 5_000,
      labels: {}, taskHealth: { recentFailures: 4, lastError: BIND_ERR, lastErrorAt: Date.now(), starting: false },
    } as unknown as SwarmServiceInfo;
    const { ctx } = fakeCtx({ services: [svc], dnsRunning: { n1: false, n2: false } });
    const r = dnsRuntimeStatus(ctx, true);
    expect(r.state).toBe('down');
    expect(r.taskError).toBe(BIND_ERR);
    expect(r.nodes.map((n) => n.hostname)).toEqual(['host-n1', 'host-n2']);
  });
});
