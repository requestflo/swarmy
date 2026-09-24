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
 * `ObservabilityConfig` is reached through a narrow typed view (`obsDb`).
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { decryptSecret } from '@swarmy/core/crypto';
import { reconcileObservabilitySuite, recordStoreProbe, systemContext } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 60_000;

interface ObsConfigRow {
  orgId: string;
  enabled: boolean;
  clickhouseDsn: string | null;
}

interface ObsDb {
  observabilityConfig: {
    findMany(args: {
      where: { enabled: true };
      select: { orgId: true; enabled: true; clickhouseDsn: true };
    }): Promise<ObsConfigRow[]>;
  };
}

function obsDb(): ObsDb {
  return prisma as unknown as ObsDb;
}

interface ClickhouseDsn {
  baseUrl: string;
  user: string;
  password: string;
  database: string;
}

function parseDsn(dsn: string): ClickhouseDsn {
  const u = new URL(dsn);
  return {
    baseUrl: `${u.protocol}//${u.host}`,
    user: decodeURIComponent(u.username || 'default'),
    password: decodeURIComponent(u.password || ''),
    database: u.pathname.replace(/^\//, '') || 'otel',
  };
}

function safeDecrypt(blob: string): string {
  try {
    return decryptSecret(blob);
  } catch {
    return blob;
  }
}

async function pingStore(dsn: ClickhouseDsn): Promise<boolean> {
  try {
    const res = await fetch(`${dsn.baseUrl}/ping`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Total on-disk bytes for this database from `system.parts`. 0 if unknown. */
async function diskUsed(dsn: ClickhouseDsn): Promise<bigint> {
  const sql = `SELECT sum(bytes_on_disk) AS bytes FROM system.parts WHERE active AND database = '${dsn.database.replace(/'/g, "\\'")}' FORMAT JSONEachRow`;
  try {
    const res = await fetch(dsn.baseUrl, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': dsn.user,
        'X-ClickHouse-Key': dsn.password,
        'Content-Type': 'text/plain',
      },
      body: sql,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 0n;
    const text = (await res.text()).trim();
    if (!text) return 0n;
    const row = JSON.parse(text.split('\n')[0]!) as { bytes?: number | string };
    return BigInt(Math.round(Number(row.bytes ?? 0)));
  } catch {
    return 0n;
  }
}

async function reconcileOrg(cfg: ObsConfigRow): Promise<void> {
  if (!cfg.clickhouseDsn) return;
  const dsn = parseDsn(safeDecrypt(cfg.clickhouseDsn));
  const reachable = await pingStore(dsn);
  const diskUsedBytes = reachable ? await diskUsed(dsn) : 0n;
  recordStoreProbe(cfg.orgId, { reachable, diskUsedBytes, checkedAt: new Date() });
}

async function tick(): Promise<void> {
  const configs = await obsDb()
    .observabilityConfig.findMany({
      where: { enabled: true },
      select: { orgId: true, enabled: true, clickhouseDsn: true },
    })
    .catch(() => [] as ObsConfigRow[]);
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
