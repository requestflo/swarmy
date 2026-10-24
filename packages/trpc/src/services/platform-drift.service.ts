/**
 * Settings › Platform → "Running off the release": the drift rows
 * (`platform-drift.ts`, pure) read from the LIVE inventory against the
 * release the cluster runs (`currentManifestOf`), and the one fix swarmy
 * offers for them — re-pin a system service with the same health-gated
 * `docker service update --update-failure-action rollback` the upgrade's
 * system step uses. Audited (`platform.drift.repin`), refused while an
 * upgrade is running or paused (the run owns those services then).
 */
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import { writeAudit } from './audit.service';
import { planDrift, type DriftRow } from './platform-drift';
import { currentManifestOf, getConfigRow } from './platform-release.service';
import { serviceUpdateScript, updateLanded } from './platform-upgrade.plan';
import { ACTIVE_RUN_STATUSES } from './platform-upgrade.pause';
import { dockerCli, refResolver, registryLogin } from './platform-upgrade.service';

const REPIN_TIMEOUT_MS = 10 * 60_000;

export interface PlatformDriftView {
  /** The release the rows are measured against. */
  version: string;
  /** No release was ever applied: the controller's own BOM is the reference. */
  builtIn: boolean;
  /** An upgrade is running or paused: it is moving these services, so nothing is re-pinned now. */
  runActive: boolean;
  rows: DriftRow[];
}

async function runActive(ctx: OrgContext): Promise<boolean> {
  const run = await ctx.db.platformUpgradeRun.findFirst({
    where: { orgId: ctx.activeOrgId, status: { in: ACTIVE_RUN_STATUSES } },
    select: { id: true },
  });
  return Boolean(run);
}

export async function getPlatformDrift(ctx: OrgContext): Promise<PlatformDriftView> {
  const row = await getConfigRow(ctx.db, ctx.activeOrgId);
  const m = currentManifestOf(row);
  return {
    version: m.version,
    builtIn: !row.currentManifest,
    runActive: await runActive(ctx),
    rows: planDrift(ctx.hub.liveInventory(ctx.activeOrgId).services, m.components),
  };
}

export interface RepinResult {
  service: string;
  to: string;
  /** Swarm kept the new task healthy (false = it rolled the service back to what it ran). */
  landed: boolean;
  state: string;
}

/** Put one drifting system service back on the release's image, health-gated. */
export async function repinSystemService(ctx: OrgContext, input: { service: string }): Promise<RepinResult> {
  if (await runActive(ctx)) throw commandRejected('a platform upgrade is running or paused — it moves the system services itself');
  const cfg = await getConfigRow(ctx.db, ctx.activeOrgId);
  const m = currentManifestOf(cfg);
  const row = planDrift(ctx.hub.liveInventory(ctx.activeOrgId).services, m.components).find((r) => r.service === input.service);
  if (!row) throw commandRejected(`${input.service} already runs what ${m.version} names`);
  if (row.action !== 'repin') throw commandRejected(`${input.service} is not re-pinned from here — it moves with an upgrade`);
  const to = (await refResolver(ctx, m))(row.key, m.components[row.key]!);
  const reg = await registryLogin(ctx);
  const r = await dockerCli(ctx, serviceUpdateScript(row.service, to, { login: reg.host }), reg.env, REPIN_TIMEOUT_MS);
  const landed = updateLanded(r);
  await writeAudit(ctx, {
    action: 'platform.drift.repin',
    targetType: 'service',
    targetId: row.service,
    metadata: { release: m.version, from: row.running, to, landed, state: r.state },
  });
  return { service: row.service, to, landed, state: r.state };
}
