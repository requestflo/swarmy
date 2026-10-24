import { describe, expect, it } from 'bun:test';
import { defaultTelemetrySettings } from '@swarmy/core';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { AGENT_SERVICE, desiredAgent } from './observability-agent';
import { containerLogsActive, reconcileContainerLogsAgent } from './observability-agent.service';
import { seedKv, useMemoryKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

const DSN = 'http://default:pw@swarmy-clickhouse:8123/otel';

function mockCtx(services: unknown[] = [], manager: string | null = 'n1') {
  const sent: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  const hub = {
    liveInventory: () => ({ services, containers: [] }),
    nodeInventory: () => [],
    managerNode: () => manager ?? undefined,
    dispatch: async (_n: string, cmd: string, payload: Record<string, unknown>) => {
      sent.push({ cmd, payload });
      return cmd === 'config.list' ? { configs: [{ name: 'swarmy-otel-agent-config-00000000' }, { name: 'other' }] } : {};
    },
  };
  const ctx = { activeOrgId: 'org1', user: { id: 'u1' }, hub } as unknown as OrgContext;
  useMemoryKv(ctx.hub);
  return { ctx, sent };
}

function seed(ctx: OrgContext, opts: { suite: boolean; collect: boolean }) {
  seedKv(ctx.hub, 'org1', 'obs', 'org1', {
    enabled: opts.suite,
    clickhouseDsn: opts.suite ? encryptSecret(DSN) : null,
    retentionDays: 7,
    telemetry: { ...defaultTelemetrySettings(7), containerLogs: { enabled: opts.collect } },
  });
}

describe('containerLogsActive (opt-in per org)', () => {
  it('needs the suite on AND the container-output setting on', async () => {
    for (const [suite, collect, want] of [[true, true, true], [true, false, false], [false, true, false]] as const) {
      const { ctx } = mockCtx();
      seed(ctx, { suite, collect });
      expect(await containerLogsActive(ctx)).toBe(want);
    }
    const never = mockCtx();
    seedKv(never.ctx.hub, 'org1', 'obs', 'org1', { enabled: true, clickhouseDsn: encryptSecret(DSN), retentionDays: 7, telemetry: null });
    expect(await containerLogsActive(never.ctx)).toBe(false);
  });
});

describe('reconcileContainerLogsAgent', () => {
  it('deploys the global agent through config.create + service.deploy, then sweeps old configs', async () => {
    const { ctx, sent } = mockCtx();
    seed(ctx, { suite: true, collect: true });
    const r = await reconcileContainerLogsAgent(ctx);
    expect(r.action).toBe('deploy');
    expect(r.skipped).toBe(false);
    expect(sent.map((s) => s.cmd)).toEqual(['config.create', 'service.deploy', 'config.list', 'config.remove']);
    expect((sent[1]!.payload.spec as { name: string; mode: unknown }).mode).toEqual({ global: {} });
    expect(sent[3]!.payload).toEqual({ name: 'swarmy-otel-agent-config-00000000' });
  });

  it('steady state sends nothing; the same signature again sends nothing', async () => {
    const want = desiredAgent({ orgId: 'org1', enabled: true })!;
    const live = { name: AGENT_SERVICE, configs: [want.config.name], runningReplicas: 3 };
    const steady = mockCtx([live]);
    seed(steady.ctx, { suite: true, collect: true });
    expect((await reconcileContainerLogsAgent(steady.ctx)).skipped).toBe(true);
    expect(steady.sent).toEqual([]);

    const pending = mockCtx();
    seed(pending.ctx, { suite: true, collect: true });
    const first = await reconcileContainerLogsAgent(pending.ctx);
    pending.sent.length = 0;
    const again = await reconcileContainerLogsAgent(pending.ctx, { lastSignature: first.signature });
    expect(again).toMatchObject({ action: 'none', skipped: true });
    expect(pending.sent).toEqual([]);
  });

  it('turning collection off removes the agent and every agent config', async () => {
    const { ctx, sent } = mockCtx([{ name: AGENT_SERVICE, configs: ['swarmy-otel-agent-config-00000000'] }]);
    seed(ctx, { suite: true, collect: false });
    expect((await reconcileContainerLogsAgent(ctx)).action).toBe('remove');
    expect(sent.map((s) => s.cmd)).toEqual(['service.remove', 'config.list', 'config.remove']);
  });

  it('skips the org (no throw) while no manager is connected', async () => {
    const { ctx, sent } = mockCtx([], null);
    seed(ctx, { suite: true, collect: true });
    expect((await reconcileContainerLogsAgent(ctx)).skipped).toBe(true);
    expect(sent).toEqual([]);
  });
});
