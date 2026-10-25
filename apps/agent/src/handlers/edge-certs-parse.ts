import { X509Certificate } from 'node:crypto';
import { EDGE_CERT_DIR, EDGE_CERTS_MAX, type EdgeCertFact } from '@swarmy/core/protocol';

/**
 * The pure half of `edgeCerts`: the in-task read and the parse of what it
 * prints. Both are exported for the golden test (edge-certs-parse.test.ts).
 *
 * Only `.crt` leaves the task: the loop globs `<issuer>/<name>/*.crt`, skips
 * anything that is not a regular file (a symlink named `x.crt` could point at
 * a key), and caps each file at 64 KiB and the count at EDGE_CERTS_MAX. The
 * parse then keeps only the first `CERTIFICATE` PEM block of each file (the
 * leaf; Caddy stores the chain after it), so even a key pasted into a `.crt`
 * is never copied into the result, and only public facts are returned.
 */

export const CRT_MARK = '#swarmy-crt ';
export const TRUNCATED_MARK = '#swarmy-truncated';

/**
 * The exec that prints every stored certificate (or only `name`'s, a host
 * the protocol already restricted to plain DNS labels), each after a
 * `#swarmy-crt <path>` line.
 */
export function edgeCertsExec(dir = EDGE_CERT_DIR, max = EDGE_CERTS_MAX, name?: string): { Cmd: string[]; Env: string[] } {
  const script = [
    'cd "$SWARMY_CERT_DIR" 2>/dev/null || exit 0',
    'n=0',
    'for f in */${SWARMY_CERT_NAME:-*}/*.crt; do',
    '  [ -f "$f" ] && [ ! -L "$f" ] || continue',
    '  n=$((n+1))',
    `  if [ "$n" -gt "$SWARMY_CERT_MAX" ]; then echo '${TRUNCATED_MARK}'; break; fi`,
    `  printf '\\n${CRT_MARK}%s\\n' "$f"`,
    '  head -c 65536 "$f"',
    'done',
  ].join('\n');
  const env = [`SWARMY_CERT_DIR=${dir}`, `SWARMY_CERT_MAX=${max}`, ...(name ? [`SWARMY_CERT_NAME=${name}`] : [])];
  return { Cmd: ['sh', '-c', script], Env: env };
}

/** `<issuer>/<name>/<name>.crt`, the only shape Caddy's file storage writes. */
const PATH = /^([^/\s]+)\/([^/\s]+)\/([^/\s]+)\.crt$/;
const LEAF = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/;

/** Pull `O=` and `CN=` out of a node:crypto distinguished name ("C=US\nO=Let's Encrypt\nCN=R11"). */
function issuerWords(dn: string): string | null {
  const field = (k: string) => dn.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() || null;
  const o = field('O');
  const cn = field('CN');
  if (o && cn) return cn.startsWith(o) ? cn : `${o} ${cn}`;
  return cn ?? o;
}

/** DNS names off `subjectAltName` ("DNS:a, DNS:b"), else the subject CN. Lower-cased. */
function namesOf(x: X509Certificate): string[] {
  const sans = (x.subjectAltName ?? '')
    .split(/,\s*/)
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4).trim().toLowerCase())
    .filter(Boolean);
  if (sans.length) return [...new Set(sans)];
  const cn = x.subject.split('\n').find((l) => l.startsWith('CN='))?.slice(3).trim().toLowerCase();
  return cn ? [cn] : [];
}

/** One `.crt` body → its leaf's facts, or null when it holds no parsable certificate. */
export function certFact(path: string, body: string): EdgeCertFact | null {
  const m = PATH.exec(path.trim());
  if (!m || m[2] !== m[3]) return null;
  const pem = LEAF.exec(body)?.[0];
  if (!pem) return null;
  try {
    const x = new X509Certificate(pem);
    const notBefore = new Date(x.validFrom);
    const notAfter = new Date(x.validTo);
    if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) return null;
    return {
      name: m[2]!,
      issuerKey: m[1]!,
      issuer: issuerWords(x.issuer),
      notBefore: notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
      names: namesOf(x),
      serial: x.serialNumber.toUpperCase(),
      fingerprint256: x.fingerprint256,
    };
  } catch {
    return null;
  }
}

/** The loop's whole stdout → the facts of every readable certificate, and whether the cap cut it short. */
export function parseCertDump(out: string): { certs: EdgeCertFact[]; truncated: boolean } {
  const certs: EdgeCertFact[] = [];
  const sections = out.split(`\n${CRT_MARK}`).slice(1);
  for (const section of sections) {
    const nl = section.indexOf('\n');
    if (nl < 0) continue;
    const fact = certFact(section.slice(0, nl), section.slice(nl + 1));
    if (fact) certs.push(fact);
  }
  return { certs, truncated: out.includes(TRUNCATED_MARK) };
}
