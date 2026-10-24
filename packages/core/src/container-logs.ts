/**
 * Container output → logs (the node agent's `filelog` tier). Pure and
 * browser-safe: shared by the controller (deploy injection, the agent render,
 * the logs read builder), the swarmy agent (the update carry) and the
 * dashboard (the source badge).
 *
 * HOW A LINE IS ATTRIBUTED — Docker does it, from container labels. A
 * service deployed while the org collects container output gets two
 * container labels (`swarmy.stack`, `swarmy.service`) and the json-file
 * option `labels=swarmy.stack,swarmy.service`, so Docker writes both into
 * every line it stores (`{"log":…,"stream":…,"attrs":{…},"time":…}`). The
 * node agent lifts `attrs` into resource attributes; a line without them
 * (swarmy's own services, plain containers) is never shipped.
 *
 * ROTATION: only `labels` is added. The bound (`max-size` × `max-file`) is
 * kept, with `max-file` floored at 2 — at 1, Docker truncates the file in
 * place and lines written since the agent's last poll would be lost; at 2+
 * it renames, and the agent drains the renamed file to its end.
 */
import type { ServiceSpec } from './protocol';
import type { TelemetrySettings } from './inputs';

/** swarmy's bounded json-file default (10 MiB × 3 per container). */
export const BOUNDED_JSON_FILE_OPTIONS: Readonly<Record<string, string>> = { 'max-size': '10m', 'max-file': '3' };

/** Resource attribute naming where a log line came from. */
export const LOG_SOURCE_ATTR = 'swarmy.log.source';
/** `stdout` = tailed container output; anything else was sent over OTLP. */
export type LogSource = 'stdout' | 'otlp';

/** Container labels Docker copies into each json-file line's `attrs`. */
export const LOG_STACK_LABEL = 'swarmy.stack';
export const LOG_SERVICE_LABEL = 'swarmy.service';
export const LOG_IDENTITY_LABELS = [LOG_STACK_LABEL, LOG_SERVICE_LABEL] as const;

/** Service label `off` keeps one noisy (or OTLP-logging) service out of collection. */
export const CONTAINER_LOGS_OPT_OUT_LABEL = 'swarmy.logs.stdout';

/** Where Docker keeps each container's json-file log on a node. */
export const DOCKER_CONTAINERS_DIR = '/var/lib/docker/containers';

/** Fewest json-file files that rotate by rename (see the header). */
export const MIN_ROTATED_FILES = 2;

/** Whether the org collects container output (absent = off: opt-in). */
export function containerLogsOn(s: Pick<TelemetrySettings, 'containerLogs'> | null | undefined): boolean {
  return s?.containerLogs?.enabled === true;
}

/**
 * json-file options with the identity labels added (merged with any `labels`
 * already listed) and the rotation bound kept, `max-file` floored at 2
 * whenever the file rotates at all (`max-size` set).
 */
export function jsonFileOptionsWithIdentity(options: Record<string, string> | undefined): Record<string, string> {
  const out = { ...(options ?? BOUNDED_JSON_FILE_OPTIONS) };
  const listed = (out.labels ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  out.labels = [...new Set([...listed, ...LOG_IDENTITY_LABELS])].join(',');
  // Docker's json-file `max-file` defaults to 1 once `max-size` is set.
  const files = Number(out['max-file'] ?? 1);
  if (out['max-size'] !== undefined && !(files >= MIN_ROTATED_FILES)) out['max-file'] = String(MIN_ROTATED_FILES);
  return out;
}

/**
 * Stamp a service so its container output can be attributed: the identity
 * container labels + the json-file `labels` option. Identity (same object)
 * when the service opted out or logs through another driver — Docker writes
 * no json-file for a loki/fluentd/journald driver, so there is nothing to tail.
 */
export function withLogIdentity(spec: ServiceSpec, c: { stack: string }): ServiceSpec {
  if (spec.labels?.[CONTAINER_LOGS_OPT_OUT_LABEL] === 'off') return spec;
  if (spec.logging && spec.logging.driver !== 'json-file') return spec;
  return {
    ...spec,
    containerLabels: { ...(spec.containerLabels ?? {}), [LOG_STACK_LABEL]: c.stack, [LOG_SERVICE_LABEL]: spec.name },
    logging: { driver: 'json-file', options: jsonFileOptionsWithIdentity(spec.logging?.options) },
  };
}

/** The deploy loop's helper: stamp every spec, or return the array unchanged when off. */
export function augmentSpecsForContainerLogs(
  specs: ServiceSpec[],
  opts: { enabled: boolean; stack: string },
): ServiceSpec[] {
  if (!opts.enabled) return specs;
  return specs.map((s) => withLogIdentity(s, { stack: opts.stack }));
}

/**
 * On an UPDATE whose spec does not carry `containerLabels`, keep the live
 * ContainerSpec labels, so a lossy rebuild (an env or image patch from the
 * inventory) never strips a service's log identity. A spec that carries them
 * is authoritative. PURE — mutates and returns `options`.
 */
export function carryContainerLabels(
  options: { TaskTemplate?: { ContainerSpec?: { Labels?: Record<string, string> } } },
  spec: Pick<ServiceSpec, 'containerLabels'>,
  live: Record<string, string> | undefined,
): typeof options {
  const cs = options.TaskTemplate?.ContainerSpec;
  if (spec.containerLabels || !cs || !live || Object.keys(live).length === 0) return options;
  cs.Labels = { ...live };
  return options;
}
