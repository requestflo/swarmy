import { afterEach, describe, expect, it } from 'bun:test';
import type { EdgeCertFact, SwarmServiceInfo } from '@swarmy/core/protocol';
import { IngressConfigSchema } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { renewCertNow } from './ingress-cert-renew.service';
import { forgetRenewLedger } from './ingress-cert-renew.limits';
import { forgetEdgeCerts } from './ingress-certs.read';
import { forgetCertHistories } from './ingress-certs.history';
import { seedKv, useMemoryKv } from './swarm-kv.service';

/**
 * Renew now is an ingress write that is refused in plain words where it is
 * not safe (shared store, old agent), counted in the audit log BEFORE it is
 * dispatched, and rate-limited per host — so a failed renew still counts
 * and a restart never resets the limit. Against an in-memory hub.
 */

afterEach(() => {
  forgetEdgeCerts();
  forgetCertHistories();
  forgetRenewLedger();
});

const HOST = 'shop.northwind.dev';
const cert = (serial: string, notBefore: string, notAfter: string): EdgeCertFact => ({
  name: HOST, issuerKey: 'acme-v02.api.letsencrypt.org-directory', issuer: "Let's Encrypt R11", notBefore, notAfter, names: [HOST], serial, fingerprint256: serial,
});
const OLD = cert('04A1', '2026-09-23T10:00:00.000Z', '2026-12-22T10:00:00.000Z');
// Issued just now (Let's Encrypt backdates notBefore by an hour).
const issued = Date.now() - 3_600_000;
const NEW = cert('05B2', new Date(issued).toISOString(), new Date(issued + 90 * 86_400_000).toISOString());

const svc: SwarmServiceInfo = {
  id: 'svc1', name: 'shop_web', image: 'web:1', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0,
  labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.ingress.routes': JSON.stringify([{ host: HOST, port: 3000, tls: 'auto' }, { host: 'api.northwind.dev', port: 8080, tls: 'auto' }]) },
  networks: [], env: [], ports: [], secrets: [], configs: [],
};
const config = IngressConfigSchema.parse({
  driver: 'caddy', orgId: 'o',
  domains: [{ domain: HOST, service: 'shop_web', port: 3000 }, { domain: 'api.northwind.dev', service: 'shop_web', port: 8080 }],
  globalOptions: { extraConfig: { applyVia: 'exec' } },
});
const deps = { loadConfig: async () => config };

let org = 0;
function world(opts: { renew?: 'renewed' | 'restored'; capabilities?: string[]; topology?: string; audited?: Date[] } = {}) {
  const orgId = `org-renew-${++org}`;
  const calls: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  const audit: string[] = [];
  let held = OLD;
  const hub = {
    isOnline: () => true,
    nodeInfoFor: () => undefined,
    latestContainers: () => [{ id: 'c1', state: 'running', labels: { 'com.docker.swarm.service.name': 'swarmy-ingress-caddy' } }],
    agentBuildFor: () => ({ version: '1.6.0', capabilities: opts.capabilities ?? ['edgeCerts', 'edgeCertRenew'] }),
    liveInventory: () => ({ services: [svc], containers: [] }),
    dispatch: async (_n: string, cmd: string, payload: Record<string, unknown>) => {
      calls.push({ cmd, payload });
      audit.push(`dispatch:${cmd}`);
      if (cmd === 'edge.certs') return { edge: true, certs: [held], checkedAt: '2026-10-24T12:00:00.000Z' };
      const outcome = opts.renew ?? 'renewed';
      if (outcome === 'renewed') held = NEW;
      return { outcome, cert: held, previous: OLD, message: outcome === 'renewed' ? 'new' : 'old one back', tookMs: 9000 };
    },
  };
  useMemoryKv(hub as never);
  if (opts.topology) seedKv(hub as never, orgId, 'ingress', orgId, { driver: 'CADDY', enabled: true, settings: { topology: opts.topology } });
  const db = {
    node: { findMany: async () => [{ id: 'n1', name: 'london-1' }] },
    auditLog: {
      create: async ({ data }: { data: { action: string } }) => void audit.push(data.action),
      findMany: async () => (opts.audited ?? []).map((ts) => ({ ts })),
    },
  };
  const ctx = { db, hub, activeOrgId: orgId, user: { id: 'u1' } } as unknown as OrgContext;
  return { ctx, calls, audit, renews: () => calls.filter((c) => c.cmd === 'edge.certRenew') };
}

describe('renewCertNow', () => {
  it('renews on the edge that holds it: audited before dispatch, the host left out of the first render only', async () => {
    const w = world();
    const r = await renewCertNow(w.ctx, HOST, deps);
    expect(r.outcome).toBe('renewed');
    expect(r.edges).toEqual([{ nodeId: 'n1', name: 'london-1', outcome: 'renewed', message: 'new' }]);
    expect(w.audit.indexOf('ingress.renewCert')).toBeLessThan(w.audit.indexOf('dispatch:edge.certRenew'));
    const p = w.renews()[0]!.payload as { name: string; without: { contents: string }; full: { contents: string }; command: string[] };
    expect(p.name).toBe(HOST);
    expect(p.without.contents).not.toContain(`${HOST} {`);
    expect(p.without.contents).toContain('api.northwind.dev');
    expect(p.full.contents).toContain(HOST);
    expect(p.command[0]).toBe('caddy');
    expect(r.facts.cert?.serial).toBe('05B2');
    expect(r.facts.renewals[0]?.by).toBe('request');
  });

  it('once an hour per host: the next ask is TOO_MANY_REQUESTS, and a renew that did not land still counts', async () => {
    const w = world({ renew: 'restored' });
    expect((await renewCertNow(w.ctx, HOST, deps)).outcome).toBe('restored');
    await expect(renewCertNow(w.ctx, HOST, deps)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(w.renews().length).toBe(1);
  });

  it('the audit log is the ledger: an ask a minute ago (before a restart) still refuses', async () => {
    const w = world({ audited: [new Date(Date.now() - 60_000)] });
    await expect(renewCertNow(w.ctx, HOST, deps)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(w.renews()).toEqual([]);
  });

  it('refused in plain words with the shared store, or an agent that predates it', async () => {
    const shared = world({ topology: 'edge-per-node' });
    await expect(renewCertNow(shared.ctx, HOST, deps)).rejects.toThrow('share one certificate store');
    const old = world({ capabilities: ['edgeCerts'] });
    await expect(renewCertNow(old.ctx, HOST, deps)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect([...shared.renews(), ...old.renews()]).toEqual([]);
  });
});
