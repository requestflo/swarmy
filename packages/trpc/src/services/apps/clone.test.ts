import { describe, expect, it } from 'bun:test';
import type { DashboardEnvMarker } from '@swarmy/app-config';
import type { InvService } from '@swarmy/core';
import type { OrgContext } from '../../context';
import type { PlanCommitInput, PlanCommitResult } from '../apps.service';
import { cloneEnvironment } from './clone';
import { dashboardEnvironments, slotStates } from './dashboard-envs';

const MARKER: DashboardEnvMarker = {
  branch: 'qa',
  from: 'production',
  secretSlots: [{ family: 'stripe-key', envFamily: 'stripe-key.qa', consumers: [{ service: 'api' }, { service: 'web', envName: 'STRIPE_KEY' }] }],
};

type Row = { orgId: string; repoId: string; environment: string; stack: string; prNumber: number; createdAt: string; desiredJson: unknown };

/** A fake ctx over AppPlan rows (newest first, as the queries order them) + an audit sink. */
function ctxWith(rows: Row[], audit: Array<{ action: string; metadata?: Record<string, unknown> }> = []): OrgContext {
  const sorted = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const match = (r: Row, w: Record<string, unknown>) =>
    (w.orgId === undefined || r.orgId === w.orgId) &&
    (w.repoId === undefined || r.repoId === w.repoId) &&
    (w.stack === undefined || r.stack === w.stack) &&
    (w.prNumber === undefined || r.prNumber === w.prNumber) &&
    !((w.NOT as { environment?: { in: string[] } } | undefined)?.environment?.in.includes(r.environment));
  return {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: {
      appPlan: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => sorted.find((r) => match(r, where)) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) => sorted.filter((r) => match(r, where)),
      },
      auditLog: { create: async ({ data }: { data: { action: string; metadata?: Record<string, unknown> } }) => audit.push(data) },
    },
  } as unknown as OrgContext;
}

const prod: Row = { orgId: 'org1', repoId: 'r1', environment: 'production', stack: 'shop', prNumber: 0, createdAt: '2026-10-20', desiredJson: {} };
const okPlan = async (_c: OrgContext, i: PlanCommitInput): Promise<PlanCommitResult> => ({
  planId: 'p1', status: 'applied', environment: i.clone!.name, stack: `shop-${i.clone!.name}`,
});

describe('cloneEnvironment — a long-lived environment through the push engine', () => {
  it('plans the branch as a clone of the source environment and audits it', async () => {
    const audit: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
    let seen: PlanCommitInput | null = null;
    const res = await cloneEnvironment(
      ctxWith([prod], audit),
      { stack: 'shop', name: 'qa', branch: 'qa', database: true, mask: true },
      async (c, i) => ((seen = i), okPlan(c, i)),
    );
    expect(seen!).toEqual({ repoId: 'r1', ref: 'qa', trigger: 'clone', clone: { name: 'qa', branch: 'qa', from: 'production', data: { mask: true } } });
    expect(res).toMatchObject({ stack: 'shop-qa', status: 'applied', declared: 'dashboard' });
    expect(audit.find((a) => a.action === 'app.environment.clone')?.metadata).toMatchObject({
      environment: 'qa', from: 'production', fromStack: 'shop', database: 'copy-masked', stack: 'shop-qa', status: 'applied',
    });
  });

  it('refuses a stack no git app planned, a preview, a taken name and a mask without a copy', async () => {
    const preview: Row = { ...prod, environment: 'preview', stack: 'shop-pr4', prNumber: 4 };
    const staging: Row = { ...prod, environment: 'staging', stack: 'shop-staging', createdAt: '2026-10-21' };
    const ctx = ctxWith([prod, preview, staging]);
    const go = (i: Partial<Parameters<typeof cloneEnvironment>[1]>) =>
      cloneEnvironment(ctx, { stack: 'shop', name: 'qa', branch: 'qa', database: false, mask: false, ...i }, okPlan);
    await expect(go({ stack: 'billing' })).rejects.toThrow('not found');
    await expect(go({ stack: 'shop-pr4' })).rejects.toThrow('not found');
    await expect(go({ name: 'staging' })).rejects.toThrow('already has an environment called staging');
    await expect(go({ mask: true })).rejects.toThrow('masking applies to a copied database');
  });

  it('audits a refusal from the plan (e.g. the name is already in swarmy.yaml)', async () => {
    const audit: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
    const refuse = async (): Promise<PlanCommitResult> => {
      throw new Error('qa is already in swarmy.yaml');
    };
    await expect(cloneEnvironment(ctxWith([prod], audit), { stack: 'shop', name: 'qa', branch: 'qa', database: false, mask: false }, refuse)).rejects.toThrow();
    expect(audit[0]?.metadata).toMatchObject({ status: 'refused', error: 'qa is already in swarmy.yaml' });
  });
});

describe('dashboardEnvironments', () => {
  it('is the newest row per environment that carries the marker — the file wins once it names it', async () => {
    const qa = (createdAt: string, desiredJson: unknown): Row => ({ ...prod, environment: 'qa', stack: 'shop-qa', createdAt, desiredJson });
    const ctx = ctxWith([prod, qa('2026-10-21', { dashboard: MARKER }), { ...qa('2026-10-21', { dashboard: MARKER }), environment: 'demo', stack: 'shop-demo' }]);
    expect((await dashboardEnvironments(ctx.db, 'r1')).map((e) => e.environment).sort()).toEqual(['demo', 'qa']);
    const adopted = ctxWith([prod, qa('2026-10-21', { dashboard: MARKER }), qa('2026-10-22', { stack: 'shop-qa' })]);
    expect(await dashboardEnvironments(adopted.db, 'r1')).toEqual([]);
  });
});

describe('slotStates — filled is Docker truth', () => {
  const svc = (name: string, secrets: string[]) => ({ name, stack: 'shop-qa', secrets }) as unknown as InvService;
  it('is filled only when every consumer mounts the environment’s own family', () => {
    expect(slotStates(MARKER.secretSlots, 'shop-qa', [svc('shop-qa_api', ['stripe-key.qa__v1']), svc('shop-qa_web', [])])[0]?.filled).toBe(false);
    // Production's family never counts.
    expect(slotStates(MARKER.secretSlots, 'shop-qa', [svc('shop-qa_api', ['stripe-key__v3']), svc('shop-qa_web', ['stripe-key__v3'])])[0]?.filled).toBe(false);
    expect(slotStates(MARKER.secretSlots, 'shop-qa', [svc('shop-qa_api', ['stripe-key.qa__v1']), svc('shop-qa_web', ['stripe-key.qa__v2'])])[0]?.filled).toBe(true);
  });
});
