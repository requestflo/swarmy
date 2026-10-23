import type { DeploySafetyView } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { toYaml, withHeader, type CodeTab } from '@/components/calm';
import { orderOf, parallelismOf, sayDuration } from '@/components/service-settings/settings-model';

const dur = (ns: number | undefined): string | undefined => (ns ? sayDuration(ns) : undefined);

/**
 * Health & rollout as code, for the picked service: its live healthcheck and
 * update_config as compose, and the app's `swarmy.deploy.safety` label as
 * swarmy reads it. Values are what runs now.
 */
export function rolloutCode(stack: string, name: string, spec: ServiceSpec, safety: DeploySafetyView | undefined): CodeTab[] {
  const hc = spec.healthcheck;
  const healthcheck = hc?.disable
    ? { disable: true }
    : hc?.test?.length
      ? { test: hc.test, interval: dur(hc.intervalNs), timeout: dur(hc.timeoutNs), retries: hc.retries || undefined, start_period: dur(hc.startPeriodNs) }
      : undefined;
  const compose = {
    services: {
      [name]: {
        ...(healthcheck ? { healthcheck } : {}),
        deploy: {
          update_config: {
            parallelism: parallelismOf(spec),
            order: orderOf(spec),
            ...(spec.updateConfig?.failureAction ? { failure_action: spec.updateConfig.failureAction } : {}),
          },
        },
      },
    },
  };
  const tabs: CodeTab[] = [{ label: 'compose', code: withHeader(`${stack} — ${name}'s live healthcheck and update_config`, toYaml(compose)) }];
  if (safety) {
    const { stackName: _s, ...label } = safety;
    tabs.push({ label: 'label', code: withHeader(`swarmy.deploy.safety on ${stack}, as swarmy reads it`, JSON.stringify(label, null, 2)) });
  }
  return tabs;
}

export const ROLLOUT_NOTE =
  'What swarmy runs now. The health check lives in your compose file or swarmy.yaml (healthcheck:); start-first/stop-first, the watch and canaries are dashboard settings with no REST route yet.';
