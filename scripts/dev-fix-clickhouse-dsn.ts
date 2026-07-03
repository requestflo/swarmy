/**
 * LOCAL DEV ONLY: repoint the observability ClickHouse DSN at localhost so the
 * host-run controller can reach the store. In production the controller is a
 * container on the `swarmy` overlay and reaches `clickhouse:8123` directly; a
 * `bun dev` controller on the Mac host cannot, so we swap the host to localhost
 * (ClickHouse must be published on host :8123 — see the docker service update).
 */
import { prisma } from '@swarmy/db';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';

const rows = await prisma.observabilityConfig.findMany({
  where: { enabled: true, clickhouseDsn: { not: null } },
});
for (const row of rows) {
  const dsn = decryptSecret(row.clickhouseDsn!);
  const local = dsn.replace(/@clickhouse:/, '@localhost:');
  if (local === dsn) {
    console.log(`org ${row.orgId}: DSN host not 'clickhouse' (${dsn.replace(/:[^@]+@/, ':***@')}), skipped`);
    continue;
  }
  // Verify the localhost DSN actually answers an authed query before persisting.
  const u = new URL(local);
  const auth = 'Basic ' + Buffer.from(`${u.username}:${decodeURIComponent(u.password)}`).toString('base64');
  const res = await fetch(`http://${u.host}/?query=${encodeURIComponent('SELECT 1')}`, {
    headers: { authorization: auth },
  });
  const body = (await res.text()).trim();
  console.log(`org ${row.orgId}: SELECT 1 via localhost → HTTP ${res.status} "${body}"`);
  if (res.ok) {
    await prisma.observabilityConfig.update({
      where: { orgId: row.orgId },
      data: { clickhouseDsn: encryptSecret(local) },
    });
    console.log(`org ${row.orgId}: DSN repointed to localhost ✓`);
  } else {
    console.log(`org ${row.orgId}: localhost query failed, NOT updating`);
  }
}
await prisma.$disconnect();
