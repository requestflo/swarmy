/**
 * Per-stack opt-in: inject OTEL_* env + Docker labels into a `ServiceSpec` so an
 * opted-in stack auto-ships OTLP to the swarmy collector — with ZERO code/image
 * changes (the magic in plans/epic-mission-control-otel.md).
 *
 * Guarantees:
 *  - Unopinionated: only env + labels are added; image/command/behaviour are
 *    untouched. For an app that ignores OTEL_* this is a strict no-op.
 *  - Never overwrites user-set values — if the spec already sets an OTEL_* var
 *    (e.g. the user points at their own collector) it wins.
 *
 * This is a PURE helper. The deploy path (stack.service / service.service) calls
 * it before dispatch when the stack is `telemetryEnabled`. We deliberately do
 * NOT edit those shared files here — see the INTEGRATION wiring snippet.
 */
import type { ServiceSpec } from '@swarmy/core/protocol';
import { OTEL_OVERLAY_NETWORK, OTLP_GRPC_PORT } from './observability-stack';

export interface OtelInjectionContext {
  orgId: string;
  stack: string;
  /** Optional environment tag, e.g. `production`. */
  environment?: string;
}

const COLLECTOR_ENDPOINT = `http://swarmy-otel-collector:${OTLP_GRPC_PORT}`;

/**
 * Return a NEW spec with OTEL_* env + telemetry labels merged in. The original
 * spec is not mutated. Only fills env keys the spec doesn't already set.
 */
export function injectOtel(spec: ServiceSpec, c: OtelInjectionContext): ServiceSpec {
  const existingEnv = spec.env ?? {};

  const resourceAttrs = [
    `swarmy.org_id=${c.orgId}`,
    `swarmy.stack=${c.stack}`,
    `swarmy.service=${spec.name}`,
    c.environment ? `deployment.environment=${c.environment}` : null,
  ]
    .filter(Boolean)
    .join(',');

  const desired: Record<string, string> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR_ENDPOINT,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
    OTEL_SERVICE_NAME: spec.name,
    OTEL_RESOURCE_ATTRIBUTES: resourceAttrs,
    // Real sampling is tail-based at the gateway; emit everything from the app.
    OTEL_TRACES_SAMPLER: 'parentbased_always_on',
  };

  // User-set values win — only fill what's absent.
  const env: Record<string, string> = { ...desired, ...existingEnv };

  const labels: Record<string, string> = {
    ...(spec.labels ?? {}),
    'swarmy.telemetry': 'on',
    'swarmy.stack': c.stack,
    'swarmy.service': spec.name,
  };

  // Ensure the service is on the overlay the collector listens on.
  const networks = spec.networks?.includes(OTEL_OVERLAY_NETWORK)
    ? spec.networks
    : [...(spec.networks ?? []), OTEL_OVERLAY_NETWORK];

  return { ...spec, env, labels, networks };
}

/**
 * Convenience for the stack-deploy loop: given a stack's telemetry flag, run
 * each spec through {@link injectOtel} (or pass through unchanged when off).
 */
export function augmentSpecsForStack(
  specs: ServiceSpec[],
  opts: { telemetryEnabled: boolean; orgId: string; stack: string; environment?: string },
): ServiceSpec[] {
  if (!opts.telemetryEnabled) return specs;
  return specs.map((spec) =>
    injectOtel(spec, { orgId: opts.orgId, stack: opts.stack, environment: opts.environment }),
  );
}
