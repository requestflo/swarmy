/**
 * Converge the node log agent tier (IO over the pure `observability-agent.ts`).
 *
 * Wanted when the org's suite is on AND its telemetry settings collect
 * container output (`containerLogs.enabled`, opt-in — swarm-kv `obs/<orgId>`).
 * Desired state is compared with the LIVE service (Docker truth): a missing
 * agent or one on a stale config is (re)deployed through the existing
 * `service.deploy` path; an agent no longer wanted is removed with its
 * configs (zero footprint when off). The caller passes the last dispatched
 * signature; an unchanged one sends nothing — the observability-reconcile
 * worker holds it per org.
 */
import { containerLogsOn } from '@swarmy/core';
import type { OrgContext } from '../context';
import { observabilityConfigRepo } from './observability-config.repo';
import {
  AGENT_SERVICE,
  agentSignature,
  desiredAgent,
  planAgent,
  staleAgentConfigs,
  type AgentAction,
  type AgentDesired,
} from './observability-agent';
import { OBS_CONFIG_LABEL } from './observability-stack';

/** Whether the org ships container output now (suite on + the opt-in setting). */
export async function containerLogsActive(ctx: OrgContext): Promise<boolean> {
  const row = await observabilityConfigRepo.find(ctx, ctx.activeOrgId).catch(() => null);
  return Boolean(row?.enabled && row.clickhouseDsn) && containerLogsOn(row?.telemetry);
}

export interface AgentReconcileResult {
  action: AgentAction;
  /** Nothing was dispatched (converged, unchanged signature, or no manager). */
  skipped: boolean;
  signature: string;
}

export async function reconcileContainerLogsAgent(
  ctx: OrgContext,
  opts: { lastSignature?: string } = {},
): Promise<AgentReconcileResult> {
  const desired = desiredAgent({ orgId: ctx.activeOrgId, enabled: await containerLogsActive(ctx) });
  const live = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === AGENT_SERVICE);
  const action = planAgent({ desired, live });
  const signature = agentSignature(desired, live);
  if (action === 'none' || signature === opts.lastSignature) return { action: 'none', skipped: true, signature };
  const nodeId = ctx.hub.managerNode(ctx.activeOrgId);
  if (!nodeId) return { action: 'none', skipped: true, signature };
  if (action === 'remove') await removeLogAgent(ctx, nodeId);
  else await deployLogAgent(ctx, nodeId, desired!);
  return { action, skipped: false, signature };
}

async function deployLogAgent(ctx: OrgContext, nodeId: string, d: AgentDesired): Promise<void> {
  try {
    await ctx.hub.dispatch(nodeId, 'config.create', {
      name: d.config.name,
      dataB64: Buffer.from(d.config.contents, 'utf8').toString('base64'),
      labels: { 'swarmy.managed': 'true', [OBS_CONFIG_LABEL]: 'true' },
    });
  } catch (e) {
    // Content-addressed: "already exists" is the same bytes.
    if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
  await ctx.hub.dispatch(nodeId, 'service.deploy', { spec: d.spec, pullPolicy: 'missing' });
  await sweepAgentConfigs(ctx, nodeId, [d.config.name]);
}

/** Remove the agent and its configs (suite off, or collection turned off). Best-effort. */
export async function removeLogAgent(ctx: OrgContext, nodeId: string): Promise<void> {
  await ctx.hub.dispatch(nodeId, 'service.remove', { service: AGENT_SERVICE }).catch(() => undefined);
  await sweepAgentConfigs(ctx, nodeId, []);
}

async function sweepAgentConfigs(ctx: OrgContext, nodeId: string, keep: string[]): Promise<void> {
  try {
    const res = await ctx.hub.dispatch<{ configs?: Array<{ name: string }> }>(nodeId, 'config.list', {});
    for (const name of staleAgentConfigs((res.configs ?? []).map((c) => c.name), keep)) {
      // An in-use config refuses removal; the next converge retries.
      await ctx.hub.dispatch(nodeId, 'config.remove', { name }).catch(() => undefined);
    }
  } catch {
    // best-effort
  }
}
