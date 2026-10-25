import { describe, expect, it } from 'bun:test';
import { EdgeCertFact, EdgeCertsMsg, EdgeCertsPayload, EdgeCertsResult } from './edge-certs';
import { AGENT_CAPABILITIES, AGENT_CAPABILITY, agentSupports } from './capabilities';
import { ControllerToAgentMessage, parseControllerEnvelope } from './messages';

/** testing-conventions invariant 5: the `edgeCerts` command parses, and only as itself. */

const CMD_ID = '00000000-0000-4000-8000-000000000301';
const FACT = {
  name: 'shop.northwind.dev',
  issuerKey: 'acme-v02.api.letsencrypt.org-directory',
  issuer: "Let's Encrypt R11",
  notBefore: '2026-09-23T10:00:00.000Z',
  notAfter: '2026-12-22T10:00:00.000Z',
  names: ['shop.northwind.dev'],
  serial: '04A1',
  fingerprint256: 'AB:CD',
};

describe('EdgeCertsPayload', () => {
  it('needs only a commandId; the timeout stays optional', () => {
    const r = EdgeCertsPayload.safeParse({ commandId: CMD_ID });
    expect(r.success && r.data.timeoutMs).toBeUndefined();
    expect(EdgeCertsPayload.safeParse({ commandId: CMD_ID, timeoutMs: 5000 }).success).toBe(true);
  });

  it('rejects a missing or malformed commandId and a non-positive timeout', () => {
    expect(EdgeCertsPayload.safeParse({}).success).toBe(false);
    expect(EdgeCertsPayload.safeParse({ commandId: 'nope' }).success).toBe(false);
    expect(EdgeCertsPayload.safeParse({ commandId: CMD_ID, timeoutMs: 0 }).success).toBe(false);
  });
});

describe('EdgeCertsMsg', () => {
  it('wraps the payload with the edgeCerts discriminant', () => {
    expect(EdgeCertsMsg.safeParse({ type: 'edgeCerts', payload: { commandId: CMD_ID } }).success).toBe(true);
  });

  it('is a ControllerToAgentMessage variant, and the envelope parses', () => {
    const r = ControllerToAgentMessage.safeParse({ type: 'edgeCerts', payload: { commandId: CMD_ID } });
    expect(r.success && r.data.type).toBe('edgeCerts');
    const env = parseControllerEnvelope({ v: 1, id: '00000000-0000-4000-8000-000000000302', ts: 1, type: 'edgeCerts', payload: { commandId: CMD_ID } });
    expect(env.type).toBe('edgeCerts');
  });

  it('rejects a wrong type literal', () => {
    expect(EdgeCertsMsg.safeParse({ type: 'edgeCert', payload: { commandId: CMD_ID } }).success).toBe(false);
    expect(ControllerToAgentMessage.safeParse({ type: 'edgeCertz', payload: { commandId: CMD_ID } }).success).toBe(false);
  });
});

describe('EdgeCertsResult', () => {
  it('round-trips a read; certs and truncated default for a node with no edge', () => {
    const r = EdgeCertsResult.safeParse({ edge: true, certs: [FACT], checkedAt: '2026-10-24T12:00:00.000Z' });
    expect(r.success && r.data).toEqual({ edge: true, certs: [FACT], truncated: false, checkedAt: '2026-10-24T12:00:00.000Z' });
    const none = EdgeCertsResult.safeParse({ edge: false, checkedAt: 'x' });
    expect(none.success && none.data.certs).toEqual([]);
  });

  it('a fact carries no key material field, and a malformed fact is refused', () => {
    expect(Object.keys(EdgeCertFact.shape)).not.toContain('pem');
    expect(Object.keys(EdgeCertFact.shape).some((k) => /key$/i.test(k) && k !== 'issuerKey')).toBe(false);
    expect(EdgeCertFact.safeParse({ ...FACT, names: 'shop.northwind.dev' }).success).toBe(false);
    expect(EdgeCertsResult.safeParse({ certs: [] , checkedAt: 'x' }).success).toBe(false);
  });
});

describe('edgeCerts capability', () => {
  it('this agent build advertises it; an agent that predates it does not support it', () => {
    expect(AGENT_CAPABILITIES).toContain(AGENT_CAPABILITY.edgeCerts);
    expect(agentSupports(undefined, 'edgeCerts')).toBe(false);
    expect(agentSupports(['dbPitrWindow'], 'edgeCerts')).toBe(false);
    expect(agentSupports(['edgeCerts'], 'edgeCerts')).toBe(true);
  });
});
