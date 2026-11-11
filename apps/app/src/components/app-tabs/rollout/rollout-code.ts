import type { DeploySafetyView, SpecHealthcheck } from '@swarmy/core';
import { composeHealthcheck } from '@swarmy/core/compose';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { toYaml, withHeader, type CodeTab } from '@/components/calm';
import { orderOf, parallelismOf } from '@/components/service-settings/settings-model';

/**
 * Health & rollout as code, for the picked service: its healthcheck and
 * update_config as compose, and the app's `swarmy.deploy.safety` label as
 * swarmy reads it. Values are what runs now; an unsaved health-check edit
 * (`draft`, from Controls) shows as what Save would write.
 */
export function rolloutCode(
  stack: string,
  name: string,
  spec: ServiceSpec,
  safety: DeploySafetyView | undefined,
  draft?: { hc: SpecHealthcheck | undefined },
): CodeTab[] {
  const healthcheck = composeHealthcheck(draft ? draft.hc : spec.healthcheck);
  const compose = {
    services: {
      [name]: {
        ...(healthcheck ? { healthcheck: { ...healthcheck } } : {}),
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
  const what = draft ? `${name}'s healthcheck after Save (unsaved) and live update_config` : `${name}'s live healthcheck and update_config`;
  const tabs: CodeTab[] = [{ label: 'compose', code: withHeader(`${stack} — ${what}`, toYaml(compose)) }];
  if (safety) {
    const { stackName: _s, ...label } = safety;
    tabs.push({ label: 'label', code: withHeader(`swarmy.deploy.safety on ${stack}, as swarmy reads it`, JSON.stringify(label, null, 2)) });
  }
  return tabs;
}

export const ROLLOUT_NOTE =
  'What swarmy runs now. Saving the health check here updates the live service (services.update healthcheck); copy the block into your compose file so the next compose deploy keeps it. Start-first/stop-first is also PATCH /api/v1/services/{id} (update_order); the watch and canaries are dashboard settings with no REST route yet.';
