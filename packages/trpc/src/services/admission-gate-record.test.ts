import { describe, expect, it } from 'bun:test';
import { GUARDRAIL_RULE_IDS } from '@swarmy/core';
import type { OrgContext } from '../context';
import { enforceAdmission, type EnforceAdmissionOptions } from './admission-gate';
import { seedKv, useMemoryKv } from './swarm-kv.service';

/**
 * Every admission decision is on the record, once, from the gate: refusals by
 * any evaluator (the image checks included, which were never audited before),
 * warnings automation let through, overrides, and clean passes that an Off
 * guardrail would have refused at Block. A clean pass with nothing to say,
 * and a block override still missing its reason, write nothing.
 */

interface Row {
  action: string;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

const ALL_OFF = GUARDRAIL_RULE_IDS.map((id) => ({ id, enabled: false, severity: 'block' }));
const IMAGE = 'localhost:5000/shop-web:1.2.0';
/** A spec every guardrail is happy with, even at Block. */
const tidy = (over: Record<string, unknown> = {}) => ({
  name: 'web',
  image: IMAGE,
  healthcheck: { test: ['CMD', 'true'] },
  resources: { limits: { memoryBytes: 268_435_456 } },
  ...over,
});

function fakeCtx(opts: { signed?: boolean; cves?: boolean; scan?: { status: string; criticalCount: number } | null; role?: string; user?: boolean }) {
  const audit: Row[] = [];
  const hub = { liveInventory: () => ({ services: [], containers: [] }) };
  useMemoryKv(hub as never);
  seedKv(hub as never, 'o1', 'registry', 'o1', {
    enabled: true,
    host: 'localhost:5000',
    requireSignedImages: opts.signed ?? false,
    blockCriticalCves: opts.cves ?? false,
    cosignPublicKey: null,
  });
  const ctx = {
    activeOrgId: 'o1',
    ...(opts.user === false ? {} : { user: { id: 'u1' } }),
    membership: { role: opts.role ?? 'owner', orgId: 'o1' },
    hub,
    db: {
      guardrailConfig: { findUnique: async () => ({ rulesJson: ALL_OFF, productionSafetyMode: false }) },
      exposureConfig: { findUnique: async () => null },
      imageScan: { findFirst: async () => (opts.scan === undefined ? null : opts.scan && { ...opts.scan, reportJson: {} }) },
      auditLog: { create: async ({ data }: { data: Row }) => void audit.push(data) },
    },
  } as unknown as OrgContext;
  return { ctx, audit };
}

const deploy = (ctx: OrgContext, spec: unknown, override = false, opts: Partial<EnforceAdmissionOptions> = {}) =>
  enforceAdmission(ctx, { kind: 'stack.deploy', orgId: 'o1', stackName: 'shop', specs: [spec], override }, { targetType: 'stack', targetId: 'shop', ...opts });

describe('the admission gate records every decision', () => {
  it('a refused unsigned image is a blocked receipt naming the check', async () => {
    const { ctx, audit } = fakeCtx({ signed: true });
    await expect(deploy(ctx, tidy())).rejects.toThrow(/images\/unsigned/);
    expect(audit.map((a) => a.action)).toEqual(['guardrails.deploy.blocked']);
    expect(audit[0]).toMatchObject({ targetType: 'stack', targetId: 'shop' });
    expect(audit[0]?.metadata).toMatchObject({
      outcome: 'blocked',
      admitted: false,
      checks: [{ rule: 'images/unsigned', outcome: 'blocked', resources: ['web'] }],
    });
  });

  it('automation lets an unscanned image through as a warned receipt, by the system', async () => {
    const { ctx, audit } = fakeCtx({ cves: true, scan: null, user: false });
    await deploy(ctx, tidy(), false, { mode: 'automation' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'guardrails.deploy.warned', actorType: 'system' });
    expect(audit[0]?.metadata).toMatchObject({ outcome: 'warned', admitted: true, mode: 'automation', checks: [{ rule: 'images/unscanned', outcome: 'warned' }] });
  });

  it('a critical CVE refuses automation; an owner override goes through as overridden', async () => {
    const scan = { status: 'FAILED', criticalCount: 2 };
    const auto = fakeCtx({ cves: true, scan });
    await expect(deploy(auto.ctx, tidy(), true, { mode: 'automation' })).rejects.toThrow(/critical CVE/);
    expect(auto.audit.map((a) => a.metadata.outcome)).toEqual(['blocked']);

    const owner = fakeCtx({ cves: true, scan });
    await deploy(owner.ctx, tidy(), true, { overrideReason: 'patched upstream tonight' });
    expect(owner.audit.map((a) => a.action)).toEqual(['stack.deploy.override']);
    expect(owner.audit[0]?.metadata).toMatchObject({
      outcome: 'overridden',
      reason: 'patched upstream tonight',
      checks: [{ rule: 'images/critical-cves', outcome: 'overridden' }],
    });
  });

  it("a member's override of a block is refused and recorded as blocked", async () => {
    const { ctx, audit } = fakeCtx({ signed: true, role: 'member' });
    await expect(deploy(ctx, tidy(), true)).rejects.toThrow(/requires an admin or owner/);
    expect(audit.map((a) => [a.action, a.metadata.outcome])).toEqual([['guardrails.deploy.blocked', 'blocked']]);
  });

  it('a block override still missing its reason is an unfinished form: nothing is written', async () => {
    const { ctx, audit } = fakeCtx({ signed: true });
    await expect(deploy(ctx, tidy(), true, { requireReason: true })).rejects.toThrow(/say why/);
    expect(audit).toEqual([]);
  });

  it('a clean pass writes nothing; one an Off guardrail would have stopped writes an allowed receipt', async () => {
    const clean = fakeCtx({});
    await deploy(clean.ctx, tidy());
    expect(clean.audit).toEqual([]);

    const loose = fakeCtx({});
    await deploy(loose.ctx, tidy({ healthcheck: undefined, privileged: true }));
    expect(loose.audit.map((a) => a.action)).toEqual(['guardrails.deploy.allowed']);
    expect(loose.audit[0]?.metadata.wouldBlock).toEqual([
      { rule: 'guardrails/require-healthcheck', level: 'off', resources: ['web'] },
      { rule: 'guardrails/no-privileged-containers', level: 'off', resources: ['web'] },
    ]);
  });
});
