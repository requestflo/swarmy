/**
 * The node log agents' live status for the Telemetry pipeline view — derived
 * from the live global service (Docker truth), never stored.
 */
import { containerLogsOn, type TelemetryLogAgentsView } from '@swarmy/core';
import type { OrgContext } from '../context';
import type { ObservabilityConfigRow } from './observability-config.repo';
import { AGENT_SERVICE } from './observability-agent';
import { deriveSuiteServiceStatus } from './observability-stack';

export function logAgentStatus(
  ctx: OrgContext,
  row: Pick<ObservabilityConfigRow, 'enabled' | 'clickhouseDsn' | 'telemetry' | 'updatedAt'>,
): TelemetryLogAgentsView {
  const collecting = Boolean(row.enabled && row.clickhouseDsn) && containerLogsOn(row.telemetry);
  const live = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === AGENT_SERVICE);
  const servers = ctx.hub.nodeInventory(ctx.activeOrgId).length;
  return {
    collecting,
    status: deriveSuiteServiceStatus({
      enabled: collecting,
      service: live,
      requestedAt: row.updatedAt.getTime(),
      now: Date.now(),
    }),
    running: live?.runningReplicas ?? 0,
    servers,
  };
}
