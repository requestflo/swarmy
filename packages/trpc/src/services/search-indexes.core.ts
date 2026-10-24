/**
 * PURE — the Meilisearch HTTP calls behind search.indexes / index / query /
 * setIndexSettings, as one `sh -c` script run INSIDE the instance container
 * (agent `exec`), and the parsers for what comes back.
 *
 * - The master key is read from the mounted secret file and handed to curl on
 *   stdin (`-H @-`), so it never sits on any process's argv.
 * - Anything a person typed (a query, settings JSON) rides as the script's
 *   `$1`, never spliced into the script. Index uids are validated
 *   (`[A-Za-z0-9_-]`) before they appear in a path.
 * - Each response ends with a marker line carrying a per-call nonce and the
 *   HTTP status, so a document that happens to contain the marker text can't
 *   split the output.
 */
import { SEARCH_PORTS, SEARCH_SECRET_TARGET } from './search.service';

const BASE = `http://localhost:${SEARCH_PORTS.meilisearch}`;
/** Seconds a settings write waits for its task before answering "processing". */
export const SETTINGS_TASK_WAIT_S = 8;

export interface MeiliRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  /** Send `$1` as the JSON body. */
  body?: boolean;
}

const UID = /^[A-Za-z0-9_-]{1,100}$/;
export function indexPath(uid: string, suffix = ''): string {
  if (!UID.test(uid)) throw new Error(`invalid index uid: ${uid}`);
  return `/indexes/${uid}${suffix}`;
}

function curl(r: MeiliRequest, marker: string): string {
  const body = r.body ? ` -H 'Content-Type: application/json' --data-binary "$1"` : '';
  return (
    `printf 'Authorization: Bearer %s\\n' "$KEY" | curl -sS -X ${r.method} -H @-${body}` +
    ` -w '\\n${marker} %{http_code}\\n' "${BASE}${r.path}"`
  );
}

function prelude(marker: string): string {
  if (!/^@@[a-z0-9]{8,}$/.test(marker)) throw new Error('bad marker');
  return (
    `command -v curl >/dev/null 2>&1 || { echo 'curl is missing from the search image' >&2; exit 127; }; ` +
    `KEY="$(cat /run/secrets/${SEARCH_SECRET_TARGET})"; `
  );
}

/** Run `requests` in order; each prints its body then `<marker> <status>`. */
export function meiliScript(requests: MeiliRequest[], marker: string): string {
  return prelude(marker) + requests.map((r) => curl(r, marker)).join('; ');
}

/**
 * PATCH the settings, then poll the task it enqueued — bounded — and print
 * the last task state as a second response.
 */
export function meiliSettingsScript(uid: string, marker: string): string {
  const patch = curl({ method: 'PATCH', path: indexPath(uid, '/settings'), body: true }, marker);
  const task = curl({ method: 'GET', path: '/tasks/$T' }, marker);
  return (
    prelude(marker) +
    `OUT="$(${patch})"; printf '%s\\n' "$OUT"; ` +
    `T="$(printf '%s' "$OUT" | sed -n 's/.*"taskUid":\\([0-9]*\\).*/\\1/p' | head -n 1)"; ` +
    `[ -n "$T" ] || exit 0; i=0; S=''; ` +
    `while [ "$i" -lt ${SETTINGS_TASK_WAIT_S} ]; do S="$(${task})"; ` +
    `case "$S" in *'"status":"succeeded"'*|*'"status":"failed"'*|*'"status":"canceled"'*) break;; esac; ` +
    `i=$((i+1)); sleep 1; done; printf '%s\\n' "$S"`
  );
}

export interface MeiliResponse {
  status: number;
  body: unknown;
  raw: string;
}

/** Split the script output into its responses (JSON-parsed where it parses). */
export function splitResponses(output: string, marker: string): MeiliResponse[] {
  const re = new RegExp(`${marker} (\\d{3})`, 'g');
  const out: MeiliResponse[] = [];
  let last = 0;
  for (let m = re.exec(output); m; m = re.exec(output)) {
    const raw = output.slice(last, m.index).trim();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    out.push({ status: Number(m[1]), body, raw });
    last = re.lastIndex;
  }
  return out;
}

export type MeiliProblem = { kind: 'unreachable' | 'notFound' | 'refused'; message: string };

/** A non-2xx response as a problem (`index_not_found` → notFound), else null. */
export function meiliProblem(r: MeiliResponse | undefined): MeiliProblem | null {
  if (!r || r.status === 0) return { kind: 'unreachable', message: 'the search engine did not answer' };
  if (r.status >= 200 && r.status < 300) return null;
  const b = (r.body ?? {}) as { message?: unknown; code?: unknown };
  const message = typeof b.message === 'string' ? b.message : `the engine answered ${r.status}`;
  if (b.code === 'index_not_found' || r.status === 404) return { kind: 'notFound', message };
  return { kind: 'refused', message };
}
