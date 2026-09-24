/**
 * A stand-in controller for the controller-store e2e: the REAL boot restore
 * (controller-store/boot.ts), the REAL supervisor (lease loop, pre-replication
 * check, supervised Litestream, fence, clean shutdown) and the REAL SQLite
 * PRAGMAs, over a plain bun:sqlite file. Only the raft lease transport is
 * faked: a JSON file stands in for the controller service's label, updated with
 * the same decideLeaseWrite the agent runs.
 *
 * It writes one row every WRITE_EVERY_MS once it holds the lease and prints
 * `COMMITTED <id>` after each commit, so the harness knows the last durable id.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { openSqlite } from '@swarmy/db';
import { decideLeaseWrite, parseLeaseLabel, type ControllerServiceOp } from '@swarmy/core/protocol';
import { runBoot } from '../../../apps/api/src/controller-store/boot';
import { ControllerStore } from '../../../apps/api/src/controller-store/supervisor';
import { storePaths } from '../../../apps/api/src/controller-store/config';

const LEASE_FILE = process.env.E2E_LEASE_FILE!;
const WRITE_EVERY_MS = Number(process.env.E2E_WRITE_EVERY_MS ?? 50);
const out = (m: string) => process.stdout.write(`${m}\n`);

const bootCode = await runBoot(process.env, (m) => out(`LOG ${m}`));
if (bootCode !== 0) {
  out(`BOOT_EXIT ${bootCode}`);
  process.exit(bootCode);
}

const db = openSqlite(storePaths().db);
db.exec('CREATE TABLE IF NOT EXISTS writes (id INTEGER PRIMARY KEY, at TEXT NOT NULL, by TEXT NOT NULL)');
const max = () => Number((db.query('SELECT coalesce(max(id), 0) AS m FROM writes').get() as { m: bigint | number }).m);
out(`BOOTED ${max()}`);

function leaseOp(op: ControllerServiceOp) {
  const live = existsSync(LEASE_FILE) ? parseLeaseLabel(readFileSync(LEASE_FILE, 'utf8')) : null;
  if (op.kind !== 'lease.acquire' && op.kind !== 'lease.renew' && op.kind !== 'lease.release') return { ok: true, lease: live };
  const { next, result } = decideLeaseWrite(live, op, Date.now());
  if (next) {
    writeFileSync(`${LEASE_FILE}.tmp`, JSON.stringify(next));
    renameSync(`${LEASE_FILE}.tmp`, LEASE_FILE);
  }
  return result;
}

let writer: ReturnType<typeof setInterval> | null = null;
const cs = new ControllerStore({
  managers: () => ['fake-manager'],
  dispatch: async (_n, p) => leaseOp(p.op),
  pragma: async (sql) => {
    db.exec(sql);
  },
  onLeader: () => {
    out(`LEADER ${process.env.SWARMY_TASK_ID}`);
    writer = setInterval(() => {
      try {
        const r = db.query('INSERT INTO writes (at, by) VALUES (?, ?) RETURNING id').get(new Date().toISOString(), process.env.SWARMY_TASK_ID!) as {
          id: bigint | number;
        };
        out(`COMMITTED ${Number(r.id)}`);
      } catch (e) {
        out(`WRITE_FAILED ${e instanceof Error ? e.message : String(e)}`);
      }
    }, WRITE_EVERY_MS);
    return () => writer && clearInterval(writer);
  },
  log: (m) => out(`LOG ${m}`),
  exit: (code) => {
    out(`EXIT ${code}`);
    process.exit(code);
  },
});
cs.start();
setInterval(async () => {
  const s = await cs.status();
  if (s.replicating) out(`STATUS replicating lastSync=${s.litestream?.lastSyncAt ?? '-'} pending=${s.litestream?.pendingWalBytes ?? '-'}`);
}, 2_000);
process.on('SIGTERM', () => void cs.shutdown(0));
