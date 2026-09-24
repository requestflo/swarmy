import { describe, expect, test } from 'bun:test';
import { IngressConfigSchema, buildCaddyfile } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { DEFAULT_INGRESS, orgDashboardDomain } from './ingress.service';
import { deriveEdgeRuntime } from './ingress-controller';

/**
 * Owner decision (2026-09-24): Caddy is the default edge for new workspaces.
 * Every other driver — `none` included — stays selectable; an existing org's
 * choice is never rewritten.
 */
describe('new-org ingress default is Caddy, enabled', () => {
  test('DEFAULT_INGRESS is CADDY + enabled', () => {
    expect(DEFAULT_INGRESS).toEqual({ driver: 'CADDY', enabled: true });
  });

  test('the first read creates the row with the Caddy default and never updates an existing one', async () => {
    const calls: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const ctx = {
      activeOrgId: 'org_new',
      db: {
        ingressConfig: {
          upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
            calls.push(args);
            return { driver: 'CADDY', enabled: true, settings: {}, updatedAt: new Date() };
          },
        },
      },
    } as unknown as OrgContext;
    await orgDashboardDomain(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.create).toEqual({ orgId: 'org_new', driver: 'CADDY', enabled: true });
    expect(calls[0]!.update).toEqual({});
  });

  test('a fresh org with no domain and no public IP still renders a valid Caddyfile', () => {
    const out = buildCaddyfile(IngressConfigSchema.parse({ driver: 'caddy', orgId: 'org_new', domains: [] }));
    expect(typeof out).toBe('string');
    // No site blocks ⇒ no ACME order can be placed for a host that can't validate.
    expect(out).not.toContain('acme');
  });

  test('a private-IP sslip.io route gets Caddy\'s local CA, not a doomed ACME order', () => {
    const out = buildCaddyfile(
      IngressConfigSchema.parse({
        driver: 'caddy',
        orgId: 'org_new',
        domains: [{ domain: 'app.192-168-64-4.sslip.io', service: 'web_app', port: 80 }],
      }),
    );
    expect(out).toContain('app.192-168-64-4.sslip.io {');
    expect(out).toContain('tls internal');
  });

  test('the Caddy edge with no manager yet reads "down" (honest), never "tracking"', () => {
    const r = deriveEdgeRuntime({ driver: 'caddy', enabled: true, taskHosts: [], now: Date.now() });
    expect(r.state).toBe('down');
    expect(r.serving).toBe(false);
  });
});
