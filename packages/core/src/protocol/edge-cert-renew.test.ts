import { describe, expect, it } from 'bun:test';
import { CertStorageName, EdgeCertRenewMsg, EdgeCertRenewPayload, EdgeCertRenewResult } from './edge-cert-renew';
import { AGENT_CAPABILITIES, AGENT_CAPABILITY, agentSupports } from './capabilities';
import { ControllerToAgentMessage, parseControllerEnvelope } from './messages';

/** testing-conventions invariant 5: the `edgeCertRenew` command parses, and only as itself. */

const CMD_ID = '00000000-0000-4000-8000-000000000311';
const minimal = {
  commandId: CMD_ID,
  name: 'shop.northwind.dev',
  service: 'swarmy-ingress-caddy',
  command: ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
  without: { path: '/etc/caddy/Caddyfile', contents: 'api.northwind.dev {\n}\n' },
  full: { path: '/etc/caddy/Caddyfile', contents: 'shop.northwind.dev {\n}\napi.northwind.dev {\n}\n' },
};

describe('EdgeCertRenewPayload', () => {
  it('accepts a minimal renew; the wait defaults to two minutes', () => {
    const r = EdgeCertRenewPayload.safeParse(minimal);
    expect(r.success && r.data.waitMs).toBe(120_000);
  });

  it('the name is a plain lower-case host: no wildcard, no shell, no path', () => {
    expect(CertStorageName.safeParse('shop.northwind.dev').success).toBe(true);
    for (const bad of ['*.northwind.dev', 'wildcard_.northwind.dev', 'Shop.dev', 'a.dev;rm -rf /', '../etc', 'shop', 'a b.dev', '$(id).dev']) {
      expect(CertStorageName.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects a relative file path, an empty command, and a wait out of bounds', () => {
    expect(EdgeCertRenewPayload.safeParse({ ...minimal, full: { path: 'Caddyfile', contents: '' } }).success).toBe(false);
    expect(EdgeCertRenewPayload.safeParse({ ...minimal, command: [] }).success).toBe(false);
    expect(EdgeCertRenewPayload.safeParse({ ...minimal, waitMs: 1_000 }).success).toBe(false);
    expect(EdgeCertRenewPayload.safeParse({ ...minimal, waitMs: 600_000 }).success).toBe(false);
    const { without: _w, ...noWithout } = minimal;
    expect(EdgeCertRenewPayload.safeParse(noWithout).success).toBe(false);
  });
});

describe('EdgeCertRenewMsg', () => {
  it('is a ControllerToAgentMessage variant, and the envelope parses', () => {
    expect(EdgeCertRenewMsg.safeParse({ type: 'edgeCertRenew', payload: minimal }).success).toBe(true);
    const r = ControllerToAgentMessage.safeParse({ type: 'edgeCertRenew', payload: minimal });
    expect(r.success && r.data.type).toBe('edgeCertRenew');
    const env = parseControllerEnvelope({ v: 1, id: '00000000-0000-4000-8000-000000000312', ts: 1, type: 'edgeCertRenew', payload: minimal });
    expect(env.type).toBe('edgeCertRenew');
  });

  it('rejects a wrong type literal, and an edgeCerts payload under this type', () => {
    expect(EdgeCertRenewMsg.safeParse({ type: 'edgeCerts', payload: minimal }).success).toBe(false);
    expect(ControllerToAgentMessage.safeParse({ type: 'edgeCertRenew', payload: { commandId: CMD_ID } }).success).toBe(false);
  });
});

describe('EdgeCertRenewResult', () => {
  it('round-trips each outcome', () => {
    for (const outcome of ['renewed', 'restored', 'no_cert'] as const) {
      const r = EdgeCertRenewResult.safeParse({ outcome, cert: null, previous: null, message: 'm', tookMs: 10 });
      expect(r.success && r.data.outcome).toBe(outcome);
    }
    expect(EdgeCertRenewResult.safeParse({ outcome: 'revoked', cert: null, previous: null, message: 'm', tookMs: 1 }).success).toBe(false);
  });
});

describe('edgeCertRenew capability', () => {
  it('this agent build advertises it; older agents do not support it', () => {
    expect(AGENT_CAPABILITIES).toContain(AGENT_CAPABILITY.edgeCertRenew);
    expect(agentSupports(['edgeCerts'], 'edgeCertRenew')).toBe(false);
    expect(agentSupports(['edgeCerts', 'edgeCertRenew'], 'edgeCertRenew')).toBe(true);
  });
});
