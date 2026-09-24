import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import {
  acmeDnsRequest,
  acmeDnsSecretName,
  acmeDnsServiceSecrets,
  acmeDnsToken,
  handleAcmeChallenge,
  orgDnsChallenge,
  requiredAcmeDnsSecrets,
  verifyAcmeDnsAuth,
} from './acme-dns.service';
import { _resetChallenges, challengeRecords, CHALLENGE_TTL_MS, stageChallenge } from './acme-challenges';
import { caddyEdgeSpec } from './ingress-controller';
import { seedKv, useMemoryKv } from './swarm-kv.service';

beforeAll(() => {
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-acme-dns';
});
afterEach(() => _resetChallenges());

const DIGEST = 'LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0';

function svc(routes: object[]): SwarmServiceInfo {
  return {
    id: 'svc1',
    name: 'shop_web',
    image: 'web:1',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.ingress.routes': JSON.stringify(routes) },
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
  };
}

function ctxWith(routes: object[], zones: string[] = ['acme.com']): OrgContext {
  const ctx = {
    activeOrgId: 'org_1',
    db: { auditLog: { create: async () => ({}) } },
    hub: { liveInventory: () => ({ services: [svc(routes)], containers: [] }) },
  } as unknown as OrgContext;
  // Zones live in the org's swarm (swarm-kv).
  useMemoryKv(ctx.hub);
  zones.forEach((zone, i) => seedKv(ctx.hub, 'org_1', 'dns-zone', `z${i}`, { zone, enabled: true, mode: 'swarmy-ns', records: [] }));
  return ctx;
}

const okPush = async () => ({ pushed: ['n1', 'n2'], failed: [] });

describe('token', () => {
  it('derived per org, verified in constant time, secret named by content', () => {
    const t = acmeDnsToken('org_1');
    expect(t).not.toBe(acmeDnsToken('org_2'));
    expect(verifyAcmeDnsAuth('org_1', `Bearer ${t}`)).toBe(true);
    expect(verifyAcmeDnsAuth('org_2', `Bearer ${t}`)).toBe(false);
    expect(verifyAcmeDnsAuth('org_1', t)).toBe(false);
    expect(verifyAcmeDnsAuth('org_1', undefined)).toBe(false);
    expect(acmeDnsSecretName(t)).toMatch(/^swarmy-acme-dns-[0-9a-f]{12}$/);
  });
});

describe('handleAcmeChallenge', () => {
  it('stages + pushes a challenge for a routed wildcard in a swarmy zone, then cleans up', async () => {
    const ctx = ctxWith([{ host: '*.acme.com', port: 80, tls: 'auto' }]);
    let pushes = 0;
    const push = async () => {
      pushes += 1;
      return okPush();
    };
    const res = await handleAcmeChallenge(ctx, 'present', { fqdn: '_acme-challenge.acme.com.', value: DIGEST }, push);
    expect(res).toEqual({ status: 200, body: 'published on 2 nameserver(s)' });
    expect(challengeRecords('org_1', 'acme.com')).toEqual([
      { name: '_acme-challenge', type: 'TXT', value: DIGEST, ttl: 10 },
    ]);
    expect((await handleAcmeChallenge(ctx, 'cleanup', { fqdn: '_acme-challenge.acme.com', value: DIGEST }, push)).status).toBe(200);
    expect(challengeRecords('org_1', 'acme.com')).toEqual([]);
    expect(pushes).toBe(2);
  });

  it('refuses names the org does not route, zones it does not serve, and junk values', async () => {
    const ctx = ctxWith([{ host: '*.acme.com', port: 80, tls: 'auto' }, { host: '*.other.io', port: 80, tls: 'auto' }]);
    expect((await handleAcmeChallenge(ctx, 'present', { fqdn: '_acme-challenge.evil.acme.com', value: DIGEST }, okPush)).status).toBe(403);
    expect((await handleAcmeChallenge(ctx, 'present', { fqdn: '_acme-challenge.other.io', value: DIGEST }, okPush)).status).toBe(403);
    expect((await handleAcmeChallenge(ctx, 'present', { fqdn: '_acme-challenge.acme.com', value: 'x y' }, okPush)).status).toBe(400);
    expect(challengeRecords('org_1', 'acme.com')).toEqual([]);
  });

  it('503 when no nameserver took it (Caddy retries the order)', async () => {
    const ctx = ctxWith([{ host: '*.acme.com', port: 80, tls: 'auto' }]);
    const res = await handleAcmeChallenge(ctx, 'present', { fqdn: '_acme-challenge.acme.com', value: DIGEST }, async () => ({
      pushed: [],
      failed: [{ nodeId: 'n1', error: 'offline' }],
    }));
    expect(res.status).toBe(503);
    expect(res.body).toContain('offline');
  });

  it('challenges expire on their own', () => {
    const now = Date.now();
    stageChallenge('org_1', { zone: 'acme.com', relName: '_acme-challenge', value: DIGEST }, now - CHALLENGE_TTL_MS - 1);
    expect(challengeRecords('org_1', 'acme.com', now)).toEqual([]);
  });

  it('the HTTP entry rejects a bad bearer before touching the org', async () => {
    const deps = { db: {}, hub: {}, auth: {} } as never;
    expect((await acmeDnsRequest(deps, { orgId: 'org_1', action: 'present', authorization: 'Bearer nope', body: {} })).status).toBe(403);
    const good = `Bearer ${acmeDnsToken('org_1')}`;
    expect((await acmeDnsRequest(deps, { orgId: 'org_1', action: 'explode', authorization: good, body: {} })).status).toBe(400);
  });
});

describe('render plan + edge wiring', () => {
  it('orgDnsChallenge: swarmy for zone wildcards, BYO for the rest, nothing without wildcards', async () => {
    const ctx = ctxWith([]);
    expect((await orgDnsChallenge(ctx, ['app.acme.com'], {})).dnsChallenge).toBeUndefined();
    const { dnsChallenge, unsolvable } = await orgDnsChallenge(ctx, ['*.acme.com', '*.other.io'], {
      acmeDns: { byo: { provider: 'cloudflare', secretName: 'swarmy-acme-dns-byo-abc', setAt: 'x' } },
    });
    expect(unsolvable).toEqual([]);
    expect(dnsChallenge).toEqual({
      hosts: { '*.acme.com': 'swarmy', '*.other.io': 'cloudflare' },
      swarmy: { endpoint: 'http://swarmy_controller:3021/ingress/acme-dns/org_1', tokenFile: '/run/secrets/swarmy-acme-dns' },
      cloudflare: { tokenFile: '/run/secrets/swarmy-acme-dns-byo' },
    });
    expect(requiredAcmeDnsSecrets(dnsChallenge, { swarmySecret: 's1', byo: { provider: 'cloudflare', secretName: 'b1', setAt: '' } })).toEqual(['s1', 'b1']);
  });

  it('edge spec mounts the DNS-01 secrets beside the cert-store ones', () => {
    const secrets = acmeDnsServiceSecrets({ swarmySecret: 'swarmy-acme-dns-abc' });
    const spec = caddyEdgeSpec({ network: 'swarmy', image: 'caddy-swarmy', certStoreSecret: 'certs-1', acmeDnsSecrets: secrets });
    expect(spec.secrets).toEqual([
      { source: 'certs-1', target: 'swarmy-edge-certs-s3', mode: 0o400 },
      { source: 'swarmy-acme-dns-abc', target: 'swarmy-acme-dns', mode: 0o400 },
    ]);
    expect(caddyEdgeSpec({ network: 'swarmy', image: 'x' }).secrets).toBeUndefined();
  });
});
