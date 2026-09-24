/**
 * Observability store-state reconcile worker (epic #10, Phase 2).
 *
 * For every org that has observability enabled, probe the deployed ClickHouse
 * store over its HTTP interface — reachability (`/ping`) plus on-disk footprint
 * (sum of `system.parts` bytes) — and keep the result IN MEMORY
 * (`recordStoreProbe`, epic-docker-native-state P1: probe results are run
 * state, never a table) so alerts can read store health without probing on
 * every evaluation. A controller restart just waits for the next tick.
 *
 * Before probing, it CONVERGES the deployed suite onto the current render
 * (`reconcileObservabilitySuite`): a missing service, a legacy host bind-mount
 * spec, a stale content-addressed Docker config or a lost store pin triggers a
 * redeploy through the normal `service.deploy` path — so installs deployed
 * with the old bind-mount specs heal on the next tick.
 *
 * Retention itself is TTL-driven inside ClickHouse (see `renderClickhouseInitSql`),
 * so this worker never deletes telemetry.
 *
 * `ObservabilityConfig` is read from each org's swarm-kv document.
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { clickhouseClient, type ClickhouseClient } from '@swarmy/core';
import { decryptSecret } from '@swarmy/core/crypto';
import { observabilityConfigRepo, reconcileObservabilitySuite, recordStoreProbe, systemContext } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 60_000;

interface ObsConfigRow {
  orgId: string;
  enabled: boolean;
  clickhouseDsn: string | null;
}

function safeDecrypt(blob: string): string {
  try {
    return decryptSecret(blob);
  } catch {
    return blob;
  }
}

/** Total on-disk bytes for this database from `system.parts`. 0 if unknown. */
async function diskUsed(ch: ClickhouseClient): Promise<bigint> {
  const sql = `SELECT sum(bytes_on_disk) AS bytes FROM system.parts WHERE active AND database = '${ch.database.replace(/'/g, "\\'")}'`;
  try {
    const [row] = await ch.json<{ bytes?: number | string }>(sql);
    return BigInt(Math.round(Number(row?.bytes ?? 0)));
  } catch {
    return 0n;
  }
}

async function reconcileOrg(cfg: ObsConfigRow): Promise<void> {
  if (!cfg.clickhouseDsn) return;
  const ch = clickhouseClient(safeDecrypt(cfg.clickhouseDsn), { timeoutMs: 5000 });
  const reachable = await ch.ping();
  const diskUsedBytes = reachable ? await diskUsed(ch) : 0n;
  recordStoreProbe(cfg.orgId, { reachable, diskUsedBytes, checkedAt: new Date() });
}

async function tick(): Promise<void> {
  // Config lives in each org's swarm (swarm-kv): unreachable orgs are skipped.
  const configs = (await observabilityConfigRepo.listAll({ db: prisma, hub }).catch(() => [] as ObsConfigRow[])).filter(
    (c) => c.enabled,
  );
  for (const cfg of configs) {
    const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, cfg.orgId);
    await reconcileObservabilitySuite(ctx).catch(() => undefined);
    await reconcileOrg(cfg).catch(() => undefined);
  }
}

export function startObservabilityReconcile(): () => void {
  const timer = setInterval(() => {
    tick().catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
