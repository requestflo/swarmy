import { describe, expect, it } from 'bun:test';
import { seedKv, useMemoryKv, type OrgContext } from '@swarmy/trpc';
import type { ApiKeyScope } from '@swarmy/core';
import { createRestApp } from '../app';
import { IngressSettingsDto } from '../dto-ingress';
import { ingressSettingsBodyToPatch } from '../mappers-ingress';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

/**
 * /ingress/settings rides ingress-settings.service: GET is any member's
 * `read`, PUT is `write` + admin (the twin of the adminProcedure setters).
 * Hermetic: the org's edge is `none`, so nothing deploys or applies; the
 * swarm is an in-memory KV and a hub that records what it is asked.
 */

type Role = 'owner' | 'admin' | 'member';
const TUNNEL_ID = 'fedcba9876543210fedcba9876543210';
const RUN_TOKEN = Buffer.from(JSON.stringify({ a: 'acct', t: TUNNEL_ID, s: 'run-secret' })).toString('base64');
const DNS_TOKEN = 'cf-token-abcdefghijklmnop-DO-NOT-LEAK';

function appFor(opts: { role?: Role; scopes?: ApiKeyScope[] } = {}) {
  const role = opts.role ?? 'admin';
  const audit: string[] = [];
  const dispatched: string[] = [];
  const db = {
    node: { findMany: async () => [] },
    statusPage: { findMany: async () => [] },
    inboundEndpoint: { findMany: async () => [] },
    aiProviderConfig: { findUnique: async () => null },
    auditLog: { create: async ({ data }: { data: { action: string } }) => void audit.push(data.action) },
  };
  const hub = {
    isOnline: () => true,
    managerNode: () => 'm1',
    managerNodes: () => ['m1'],
    nodeInventory: () => [],
    nodeInfoFor: () => undefined,
    liveInventory: () => ({ services: [], containers: [] }),
    latestContainers: () => [],
    dispatch: async (_node: string, cmd: string) => {
      dispatched.push(cmd);
      return {};
    },
  };
  useMemoryKv(hub as never);
  seedKv(hub as never, 'org1', 'ingress', 'org1', { driver: 'NONE', enabled: true, settings: {} });
  const ctx = { db, hub, user: { id: 'user1' }, activeOrgId: 'org1', membership: { role, orgId: 'org1' }, reqHeaders: new Headers() };
  const app = createRestApp({
    resolveContextFromApiKey: async () => ({
      ctx: ctx as unknown as OrgContext,
      apiKey: { id: 'k1', scopes: opts.scopes ?? ['write'], stackNames: null },
    }),
  });
  const call = async (method: string, body?: unknown) => {
    const res = await app.request('/ingress/settings', {
      method,
      headers: { authorization: 'Bearer swk_test_x', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
  };
  return { call, audit, dispatched };
}

describe('GET /ingress/settings', () => {
  it('reads the defaults for any member with a read key', async () => {
    const t = appFor({ role: 'member', scopes: ['read'] });
    const r = await t.call('GET');
    expect(r.status).toBe(200);
    expect(IngressSettingsDto.safeParse(r.json).success).toBe(true);
    expect(r.json).toMatchObject({
      org_id: 'org1', driver: 'none', enabled: true, topology: 'controller', controller_image: null, target_nodes: [],
      tls: { acme_email: null, on_demand: false, ask_url: null }, tunnel: null, dns_provider: null,
    });
    expect(t.dispatched).toEqual([]); // a read never dispatches
  });
});

describe('PUT /ingress/settings', () => {
  it('writes the whole patch and GET reads it back — secrets as set, never values', async () => {
    const t = appFor();
    const put = await t.call('PUT', {
      enabled: false,
      controller_image: 'ghcr.io/acme/caddy:3',
      target_nodes: ['n1'],
      tls: { acme_email: 'ops@acme.io', on_demand: true, ask_url: 'https://ctl.acme.io/ask' },
      tunnel: { run_token: RUN_TOKEN, tunnel_name: 'edge', replicas: 2 },
      dns_provider: { provider: 'cloudflare', api_token: DNS_TOKEN },
    });
    expect(put.status).toBe(200);
    const get = await t.call('GET');
    expect(get.json).toEqual(put.json);
    expect(get.json).toMatchObject({
      enabled: false, controller_image: 'ghcr.io/acme/caddy:3', target_nodes: ['n1'],
      tls: { acme_email: 'ops@acme.io', on_demand: true, ask_url: 'https://ctl.acme.io/ask' },
      tunnel: { tunnel_id: TUNNEL_ID, tunnel_name: 'edge', replicas: 2, run_token_set: true },
      dns_provider: { provider: 'cloudflare', api_token_set: true },
    });
    expect(put.text).not.toContain(RUN_TOKEN);
    expect(put.text).not.toContain(DNS_TOKEN);
    expect(t.dispatched).toEqual(['secret.create']); // the DNS token's Docker secret, nothing else
    expect(t.audit).toEqual(['ingress.updateSettings']);
  });

  it('null clears; a field left out keeps its value', async () => {
    const t = appFor();
    await t.call('PUT', { controller_image: 'x:1', tls: { acme_email: 'ops@acme.io' } });
    const r = await t.call('PUT', { controller_image: null });
    expect(r.json.controller_image).toBeNull();
    expect(r.json.tls.acme_email).toBe('ops@acme.io');
  });

  it('refuses the whole body when any part is invalid — nothing changes', async () => {
    const t = appFor();
    for (const body of [
      { driver: 'traefik' },
      { enabled: true, colour: 'blue' },
      { tls: { acme_email: 'nope' } },
      { enabled: false, tunnel: { run_token: 'x'.repeat(40) } },
      { tls: { on_demand: true } },
    ]) {
      const r = await t.call('PUT', body);
      expect(r.status).toBe(400);
    }
    expect((await t.call('GET')).json.enabled).toBe(true);
    expect(t.audit).toEqual([]);
    expect(t.dispatched).toEqual([]);
  });

  it('is admin-only and needs write', async () => {
    const member = await appFor({ role: 'member' }).call('PUT', { enabled: false });
    expect(member.status).toBe(403);
    expect(member.json.swarmy_code).toBe('POLICY_DENIED');
    expect((await appFor({ scopes: ['read'] }).call('PUT', { enabled: false })).status).toBe(403);
    expect((await appFor({ scopes: ['deploy'] }).call('PUT', { enabled: false })).status).toBe(403);
  });
});

describe('ingressSettingsBodyToPatch', () => {
  it('maps snake to camel, keeps null (clear) and drops what was left out', () => {
    expect(ingressSettingsBodyToPatch({ tunnel: null, tls: { ask_url: null }, target_nodes: [] })).toEqual({
      tunnel: null,
      tls: { askUrl: null },
      targetNodes: [],
    });
    expect(ingressSettingsBodyToPatch({})).toEqual({});
  });
});
