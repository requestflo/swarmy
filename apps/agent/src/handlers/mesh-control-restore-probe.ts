/**
 * The two one-shot Litestream scripts behind a control-plane `restore`, and
 * the parse of the first one's report. Pure (strings in, facts out) so the
 * shapes are tested here; mesh-control-restore.ts runs them.
 *
 *  1. PROBE: what this node's volume holds (store.db and its WAL: size and
 *     mtime; Litestream's own LTX files beside it) and what the backup holds
 *     (`litestream ltx -json -level all`: every LTX file with its TXIDs, size
 *     and time). Lines start with `@@` so Litestream's logs never confuse it.
 *  2. RESTORE: every DB into `<db>.restoring` first; only when all of them
 *     worked, this node's files are moved aside into `$SWARMY_KEEP_AS` (inside
 *     the volume, never deleted) and the restored ones take their place.
 *
 * The Litestream config holds no credentials (they ride the env), so it is
 * written to the one-shot's own /tmp.
 */
import type { LtxFile, RestoreFacts } from '@swarmy/mesh';

export const DATA_DIR = '/var/lib/netbird';
const CONFIG = '/tmp/swarmy-litestream.yml';
const WRITE_CONFIG = `(umask 077; printf '%s' "$SWARMY_LS_CONFIG" | base64 -d > ${CONFIG}); unset SWARMY_LS_CONFIG`;
/** Bounds a listing against a backup that doesn't answer (Litestream retries forever). */
export const PROBE_LIST_TIMEOUT_S = 60;

export const PROBE_SCRIPT = [
  'set -u',
  WRITE_CONFIG,
  `f=${DATA_DIR}/store.db`,
  `for p in "$f" "$f-wal"; do [ -e "$p" ] && stat -c '@@file %s %Y %n' "$p"; done`,
  `[ -d "${DATA_DIR}/.store.db-litestream" ] && find "${DATA_DIR}/.store.db-litestream" -name '*.ltx' -exec stat -c '@@ltx %s %Y %n' {} +`,
  `if out=$(timeout ${PROBE_LIST_TIMEOUT_S} litestream ltx -json -level all -config ${CONFIG} "$f" 2>/tmp/ltx.err); then`,
  `  printf '@@replica %s\\n' "$(printf '%s' "$out" | tr -d '\\n')"`,
  `else rc=$?; printf '@@replica-error %s %s\\n' "$rc" "$(tail -c 300 /tmp/ltx.err | tr '\\n' ' ')"; fi`,
  'exit 0',
].join('\n');

export const RESTORE_SCRIPT = [
  'set -eu',
  WRITE_CONFIG,
  `D=${DATA_DIR}`,
  'got=""',
  'for db in store idp events; do',
  '  f=$D/$db.db',
  '  rm -f "$f.restoring"',
  `  litestream restore -config ${CONFIG} -if-replica-exists -o "$f.restoring" "$f"`,
  '  if [ -s "$f.restoring" ]; then got="$got $db"; fi',
  'done',
  'aside=$D/$SWARMY_KEEP_AS',
  'for db in $got; do',
  '  f=$D/$db.db',
  // The WAL, shm and Litestream's own LTX dir describe the OLD file: they go with it.
  '  for p in "$f" "$f-wal" "$f-shm" "$D/.$db.db-litestream"; do',
  '    if [ -e "$p" ]; then [ -d "$aside" ] || { echo "@@moving"; mkdir -p "$aside"; }; mv "$p" "$aside/"; fi',
  '  done',
  '  mv "$f.restoring" "$f"',
  'done',
  'if [ -d "$aside" ]; then echo "@@kept $SWARMY_KEEP_AS"; fi',
].join('\n');

/** `swarmy-stale-2026-10-24T12-10-00Z`: where this node's replaced files go, inside the volume. */
export function keptAsName(now: Date): string {
  return `swarmy-stale-${now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}`;
}

const LTX_PATH = /\/ltx\/(\d+)\/([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/;

interface ListedLtx {
  level: number;
  min_txid: string;
  max_txid: string;
  size: number;
  timestamp: string;
}

function listed(json: string): LtxFile[] {
  const rows = JSON.parse(json || '[]') as ListedLtx[] | null;
  return (rows ?? []).map((r) => ({
    level: r.level,
    minTxid: BigInt(`0x${r.min_txid}`),
    maxTxid: BigInt(`0x${r.max_txid}`),
    size: r.size,
    at: Date.parse(r.timestamp),
  }));
}

export function parseProbe(stdout: string): RestoreFacts {
  const facts: RestoreFacts = {
    local: { hasData: false, modifiedAt: null, ltx: [] },
    replica: { reachable: false, error: 'the probe said nothing about the backup', ltx: [] },
  };
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const [tag, a = '', b = '', ...rest] = line.split(' ');
    if (tag === '@@file') {
      const size = Number(a);
      const mtime = Number(b) * 1000;
      if (rest.join(' ').endsWith('/store.db')) facts.local.hasData = size > 0;
      if (Number.isFinite(mtime)) facts.local.modifiedAt = Math.max(facts.local.modifiedAt ?? 0, mtime);
    } else if (tag === '@@ltx') {
      const m = LTX_PATH.exec(rest.join(' '));
      if (m) facts.local.ltx.push({ level: Number(m[1]), minTxid: BigInt(`0x${m[2]}`), maxTxid: BigInt(`0x${m[3]}`), size: Number(a), at: Number(b) * 1000 });
    } else if (tag === '@@replica') {
      try {
        facts.replica = { reachable: true, ltx: listed(line.slice('@@replica '.length)) };
      } catch {
        facts.replica = { reachable: false, error: 'the backup listing was unreadable', ltx: [] };
      }
    } else if (tag === '@@replica-error') {
      const detail = [b, ...rest].join(' ').trim();
      const error = a === '124' ? `the backup did not answer within ${PROBE_LIST_TIMEOUT_S} s` : `litestream ltx exited ${a}${detail ? `: ${detail}` : ''}`;
      facts.replica = { reachable: false, error, ltx: [] };
    }
  }
  return facts;
}
