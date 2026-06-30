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
 * it before dispatch when the stack is opted in. Per docker-native-storage the
 * opt-in is now a Docker LABEL on the stack's services (`swarmy.otel.enabled`),
 * read from the live inventory at deploy time — never a DB column. We deliberately
 * do NOT edit those shared files here — see the INTEGRATION wiring snippet.
 */
import type { ServiceSpec } from '@swarmy/core/protocol';
import { OTEL_OVERLAY_NETWORK, OTLP_GRPC_PORT } from './observability-stack';

/**
 * The Docker-truth per-stack opt-in marker. Stamped on every service in a stack
 * (by `observability.enableForStack`, and re-stamped here on every injected
 * deploy so it survives redeploys); the deploy path reads it back from the live
 * inventory to decide whether to inject. Replaces the old `Stack.telemetryEnabled`
 * DB column.
 */
export const OTEL_ENABLED_LABEL = 'swarmy.otel.enabled';

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
    // Self-describing: re-stamp the opt-in marker so a redeploy of an opted-in
    // stack keeps the label even if it was only ever set via enableForStack.
    [OTEL_ENABLED_LABEL]: 'true',
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

/**
 * Resolve whether a single service should get OTEL injection, honouring a
 * three-state precedence:
 *  - service-level override wins when set (`true` forces on, `false` forces off,
 *    even if the stack is enabled — opt a noisy service out, or a single service
 *    in while the rest of the stack stays dark);
 *  - otherwise the stack-level flag decides.
 *
 * Pure — no IO. The deploy path passes the resolved Stack/Service flags.
 */
export function resolveServiceTelemetry(opts: {
  stackEnabled: boolean;
  serviceOverride?: boolean | null;
}): boolean {
  if (opts.serviceOverride === true) return true;
  if (opts.serviceOverride === false) return false;
  return opts.stackEnabled;
}

/**
 * Per-service injection: run ONE spec through {@link injectOtel} only when its
 * resolved telemetry state (service override ?? stack flag) is on. Reuses the
 * same augment helper so stack- and service-level injection are identical
 * output. The deploy path calls this when deploying an individual service.
 */
export function augmentSpecForService(
  spec: ServiceSpec,
  opts: {
    stackEnabled: boolean;
    serviceOverride?: boolean | null;
    orgId: string;
    stack: string;
    environment?: string;
  },
): ServiceSpec {
  const on = resolveServiceTelemetry({
    stackEnabled: opts.stackEnabled,
    serviceOverride: opts.serviceOverride,
  });
  if (!on) return spec;
  return injectOtel(spec, { orgId: opts.orgId, stack: opts.stack, environment: opts.environment });
}
