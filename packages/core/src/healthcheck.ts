import type { ServiceHealthcheckInput } from './inputs';
import type { ServiceSpec } from './protocol/commands';

/**
 * The service health check, edited and run (board AppRollout). PURE, and
 * shared by the controller (services.update, "Test now") and the dashboard.
 * The check lives on the Docker service spec (`ContainerSpec.Healthcheck`),
 * never in swarmy's store.
 */

export type SpecHealthcheck = NonNullable<ServiceSpec['healthcheck']>;

/** Docker's value for a HEALTHCHECK field left unset (or 0). docs.docker.com, HEALTHCHECK. */
export const DOCKER_HEALTH_DEFAULTS = { intervalSec: 30, timeoutSec: 30, retries: 3, startSec: 0 } as const;

/** A health-check edit that can't be applied (it says nothing to ask for). */
export class HealthcheckEditError extends Error {}

/**
 * The probe for "GET this path": curl if the image has it, else wget, run
 * inside the container against its own port. Exits non-zero on an HTTP
 * error, a refused connection, or neither tool being there. The URL is
 * single-quoted; the input schema keeps quotes and spaces out of the path.
 */
export function httpProbeTest(path: string, port: number): string[] {
  const url = `'http://localhost:${port}${path}'`;
  return ['CMD-SHELL', `curl -fsS -o /dev/null ${url} || wget -q -O /dev/null ${url}`];
}

/** Docker's test forms: CMD / CMD-SHELL kept, a bare argv runs as CMD. */
function normalizeTest(test: string[]): string[] {
  const head = test[0];
  return head === 'CMD' || head === 'CMD-SHELL' || head === 'NONE' ? test : ['CMD', ...test];
}

type DurKey = 'intervalNs' | 'timeoutNs' | 'startPeriodNs';

function setDuration(out: SpecHealthcheck, key: DurKey, seconds: number | undefined): void {
  if (seconds === undefined) return;
  if (seconds > 0) out[key] = Math.round(seconds * 1e9);
  else delete out[key];
}

/**
 * Merge an edit over the live check. `null` → no check of the service's own
 * (undefined; the image's applies). Throws `HealthcheckEditError` when the
 * result would have nothing to ask for.
 */
export function applyHealthcheckEdit(
  live: SpecHealthcheck | undefined,
  edit: ServiceHealthcheckInput | null,
): SpecHealthcheck | undefined {
  if (edit === null) return undefined;
  if (edit.disable || edit.test?.[0] === 'NONE') return { disable: true };
  // A switched-off check has nothing to carry: the edit starts it fresh.
  const src: SpecHealthcheck = live && !live.disable ? live : {};
  const { disable: _off, ...out } = src;
  if (edit.http) out.test = httpProbeTest(edit.http.path, edit.http.port);
  else if (edit.test) out.test = normalizeTest(edit.test);
  setDuration(out, 'intervalNs', edit.intervalSeconds);
  setDuration(out, 'timeoutNs', edit.timeoutSeconds);
  setDuration(out, 'startPeriodNs', edit.startPeriodSeconds);
  if (edit.retries !== undefined) {
    if (edit.retries > 0) out.retries = edit.retries;
    else delete out.retries;
  }
  if (!out.test?.length) throw new HealthcheckEditError('say what the health check asks for: a path to GET or a command to run');
  return out;
}

/**
 * The argv "Test now" execs in a running task — Docker's own reading of the
 * test: `CMD` runs its argv, `CMD-SHELL` runs through `/bin/sh -c`, a bare
 * argv runs as is. null when there is nothing to run (no test, or NONE).
 */
export function healthcheckExecCmd(test: string[] | undefined): string[] | null {
  if (!test?.length) return null;
  const [kind, ...rest] = test;
  if (kind === 'NONE') return null;
  if (kind === 'CMD-SHELL') return rest.length ? ['/bin/sh', '-c', rest.join(' ')] : null;
  if (kind === 'CMD') return rest.length ? rest : null;
  return test;
}

/** How long Docker gives one probe (the check's timeout, else its default), in ms. */
export function healthcheckTimeoutMs(hc: SpecHealthcheck | undefined): number {
  return hc?.timeoutNs ? Math.ceil(hc.timeoutNs / 1e6) : DOCKER_HEALTH_DEFAULTS.timeoutSec * 1000;
}
