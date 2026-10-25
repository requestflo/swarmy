import path from 'node:path';
import { EDGE_CERT_DIR } from '@swarmy/core/protocol';

/**
 * The in-task shell steps of Renew now (`edgeCertRenew`), pure so the golden
 * test can run them against a real temp tree. Each takes the host through
 * env (`SWARMY_CERT_NAME`, already restricted by the protocol to plain DNS
 * labels) and works under Caddy's data directory:
 *
 *  - `moveAside`: `certificates/<issuer>/<name>/` → `swarmy-renew/<issuer>/<name>/`
 *    on the same volume (a rename: nothing is deleted, nothing copied out);
 *  - `restore`: the reverse, except where a new certificate already landed
 *    (that one is kept, and the old copy dropped);
 *  - `dropBackup`: delete the moved-aside copy once a new certificate is stored.
 *
 * `restore` also runs first on every renew, so a renew interrupted half-way
 * (the agent restarted mid-wait) puts its copy back before anything else.
 */

/** Caddy's data directory inside the edge task (the `/data` volume). */
export const EDGE_CADDY_DATA = path.posix.dirname(EDGE_CERT_DIR);
/** Where a renew keeps the old certificate while the new one is ordered. */
export const RENEW_ASIDE = 'swarmy-renew';

type Exec = { Cmd: string[]; Env: string[] };

function step(lines: string[], name: string, data: string): Exec {
  return {
    Cmd: ['sh', '-c', ['cd "$SWARMY_CADDY_DATA" || exit 3', ...lines].join('\n')],
    Env: [`SWARMY_CADDY_DATA=${data}`, `SWARMY_CERT_NAME=${name}`],
  };
}

export function moveAsideExec(name: string, data = EDGE_CADDY_DATA): Exec {
  return step(
    [
      'n=0',
      'for d in certificates/*/"$SWARMY_CERT_NAME"; do',
      '  [ -d "$d" ] && [ ! -L "$d" ] || continue',
      '  i=${d#certificates/}; i=${i%%/*}',
      `  mkdir -p "${RENEW_ASIDE}/$i" && rm -rf "${RENEW_ASIDE}/$i/$SWARMY_CERT_NAME" && mv "$d" "${RENEW_ASIDE}/$i/" || exit 4`,
      '  n=$((n+1))',
      'done',
      'echo "moved $n"',
    ],
    name,
    data,
  );
}

export function restoreExec(name: string, data = EDGE_CADDY_DATA): Exec {
  return step(
    [
      `for d in ${RENEW_ASIDE}/*/"$SWARMY_CERT_NAME"; do`,
      '  [ -d "$d" ] || continue',
      `  i=\${d#${RENEW_ASIDE}/}; i=\${i%%/*}`,
      '  if [ -f "certificates/$i/$SWARMY_CERT_NAME/$SWARMY_CERT_NAME.crt" ]; then rm -rf "$d"; continue; fi',
      '  mkdir -p "certificates/$i" && rm -rf "certificates/$i/$SWARMY_CERT_NAME" && mv "$d" "certificates/$i/" || exit 4',
      'done',
      'echo restored',
    ],
    name,
    data,
  );
}

export function dropBackupExec(name: string, data = EDGE_CADDY_DATA): Exec {
  return step([`for d in ${RENEW_ASIDE}/*/"$SWARMY_CERT_NAME"; do [ -d "$d" ] && rm -rf "$d"; done`, 'echo dropped'], name, data);
}
