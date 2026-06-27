/**
 * Observability store-state reconcile worker (epic #10, Phase 2).
 *
 * For every org that has observability enabled, probe the deployed ClickHouse
 * store over its HTTP interface — reachability (`/ping`) plus on-disk footprint
 * (sum of `system.parts` bytes) — and upsert the result into
 * `ObservabilityStoreState` so the UI can surface store health + growth without
 * the read path having to probe on every request.
 *
 * Retention itself is TTL-driven inside ClickHouse (see `renderClickhouseInitSql`),
 * so this worker is light: it observes, it does not delete.
 *
 * `ObservabilityConfig` / `ObservabilityStoreState` are reached through a narrow
 * typed view (`obsDb`) until the Prisma client is regenerated with the new
 * models (see the INTEGRATION snippet) — same pattern as `dr-reconcile.ts`.
 */
import { prisma } from '@swarmy/db';
import { decryptSecret } from '@swarmy/core/crypto';

const TICK_MS = 60_000;

interface ObsConfigRow {
  orgId: string;
  enabled: boolean;
  clickhouseDsn: string | null;
}

interface ObsStoreStateUpsertArgs {
  where: { orgId: string };
  create: {
    orgId: string;
    status: string;
    reachable: boolean;
    diskUsedBytes: bigint;
    lastCheckedAt: Date;
  };
  update: {
    status: string;
    reachable: boolean;
    diskUsedBytes: bigint;
    lastCheckedAt: Date;
  };
}

interface ObsDb {
  observabilityConfig: {
    findMany(args: {
      where: { enabled: true };
      select: { orgId: true; enabled: true; clickhouseDsn: true };
    }): Promise<ObsConfigRow[]>;
  };
  observabilityStoreState: {
    upsert(args: ObsStoreStateUpsertArgs): Promise<unknown>;
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
  const status = reachable ? 'RUNNING' : 'UNREACHABLE';
  const now = new Date();

  await obsDb().observabilityStoreState.upsert({
    where: { orgId: cfg.orgId },
    create: { orgId: cfg.orgId, status, reachable, diskUsedBytes, lastCheckedAt: now },
    update: { status, reachable, diskUsedBytes, lastCheckedAt: now },
  });
}

async function tick(): Promise<void> {
  const configs = await obsDb()
    .observabilityConfig.findMany({
      where: { enabled: true },
      select: { orgId: true, enabled: true, clickhouseDsn: true },
    })
    .catch(() => [] as ObsConfigRow[]);
  for (const cfg of configs) {
    await reconcileOrg(cfg).catch(() => undefined);
  }
}

export function startObservabilityReconcile(): () => void {
  const timer = setInterval(() => {
    tick().catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
