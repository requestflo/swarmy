/**
 * `SENTRY_*` env injection for opted-in stacks (pure). The error-tracking
 * twin of `otel-injection.ts`, with the same guarantees:
 *
 *  - only env + one label are added — never image, command or behaviour; an
 *    app without a Sentry SDK ignores the vars (strict no-op);
 *  - a user-set `SENTRY_*` value always wins (point at your own Sentry);
 *  - off = the ORIGINAL array back (identity), so opting out is a clean revert.
 *
 * Opt-in is the `swarmy.errors.enabled` service LABEL (Docker truth), stamped
 * by `swarmy.yaml` `errors: true`, a template, a compose `labels:` entry or
 * the dashboard toggle. The DSN comes from the stack's `ErrorProject`.
 */
import type { ServiceSpec } from '@swarmy/core/protocol';

export const ERRORS_ENABLED_LABEL = 'swarmy.errors.enabled';
/** Where a deploy's git sha comes from: the git-apps compiler's label, else the OCI image label. */
// Literal copies of APP_COMMIT_LABEL / APP_ENV_LABEL (apps/live.ts) — importing that
// module here would pull the managed-data services into the deploy path's import
// graph. injection.test.ts pins the parity.
export const COMMIT_LABELS = ['swarmy.app.commit', 'org.opencontainers.image.revision'] as const;
export const ENV_LABELS = ['swarmy.app.environment'] as const;

/** True when any spec in the deploy asks for error tracking. */
export function specsRequestErrors(specs: readonly ServiceSpec[]): boolean {
  return specs.some((s) => s.labels?.[ERRORS_ENABLED_LABEL] === 'true');
}

/** An explicit `swarmy.errors.enabled=false` on a service opts that one service out. */
function serviceOptedOut(spec: ServiceSpec): boolean {
  return spec.labels?.[ERRORS_ENABLED_LABEL] === 'false';
}

export function releaseFor(spec: ServiceSpec): string | undefined {
  for (const k of COMMIT_LABELS) {
    const v = spec.labels?.[k];
    if (v) return v;
  }
  return undefined;
}

export interface ErrorsInjection {
  /** The project's DSN (`https://<key>@<controller>/<projectId>`). */
  dsn: string;
  environment?: string;
}

/** Return a NEW spec with SENTRY_DSN / SENTRY_RELEASE / SENTRY_ENVIRONMENT filled in where absent. */
export function injectErrors(spec: ServiceSpec, c: ErrorsInjection): ServiceSpec {
  const release = releaseFor(spec);
  const environment = ENV_LABELS.map((k) => spec.labels?.[k]).find(Boolean) ?? c.environment ?? 'production';
  const desired: Record<string, string> = {
    SENTRY_DSN: c.dsn,
    SENTRY_ENVIRONMENT: environment,
    ...(release ? { SENTRY_RELEASE: release } : {}),
  };
  return {
    ...spec,
    env: { ...desired, ...(spec.env ?? {}) },
    labels: { ...(spec.labels ?? {}), [ERRORS_ENABLED_LABEL]: 'true' },
  };
}

/**
 * The deploy-loop helper: identity when off; otherwise every service not
 * explicitly opted out gets the vars.
 */
export function augmentSpecsForErrors(
  specs: ServiceSpec[],
  opts: { enabled: boolean; dsn: string | null; environment?: string },
): ServiceSpec[] {
  if (!opts.enabled || !opts.dsn) return specs;
  const dsn = opts.dsn;
  return specs.map((s) => (serviceOptedOut(s) ? s : injectErrors(s, { dsn, environment: opts.environment })));
}
