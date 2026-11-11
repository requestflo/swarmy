import { SCALE_TO_ZERO_IDLE_LABEL, SCALE_TO_ZERO_LABEL, SCALE_TO_ZERO_TARGET_LABEL, type InvService } from '@swarmy/core';
import { curl, toYaml, withHeader, type CodeTab } from '@/components/calm';
import { fmtMem } from '@/components/service-settings/settings-model';
import { idleDuration } from './sleep-sim';
import { sizeYaml, type Limits } from './size-model';

export interface PickedCode {
  inv: InvService;
  name: string;
  limits: Limits | undefined;
  /** Sleep after this many idle seconds; null = always on. */
  sleepSec: number | null;
}

/**
 * The Code view for Config › Scaling, for the picked service: swarmy.yaml
 * (`replicas`, `size` or `cpu`/`memory`, `sleep_after`) when the app deploys
 * from git, the live deploy block as compose, and the REST calls (copies;
 * size and sleep through PATCH /services/{id}: `resources`, and the
 * `swarmy.scaleToZero.*` labels the dashboard's sleep switch writes).
 * Values are what runs now, not what the file says.
 */
export function scalingPageCode(stack: string, p: PickedCode, git: { configPath: string; branch: string } | null): CodeTab[] {
  const replicas = p.inv.replicas.desired;
  const yaml = {
    services: {
      [p.name]: {
        replicas,
        ...sizeYaml(p.limits),
        ...(p.sleepSec !== null ? { sleep_after: idleDuration(p.sleepSec) } : {}),
      },
    },
  };
  const limits = p.limits;
  const compose = {
    services: {
      [p.name]: {
        deploy: {
          ...(p.inv.mode === 'global' ? { mode: 'global' } : { replicas }),
          ...(limits?.cpus !== undefined || limits?.memoryBytes !== undefined
            ? {
                resources: {
                  limits: {
                    ...(limits.cpus !== undefined ? { cpus: String(limits.cpus) } : {}),
                    ...(limits.memoryBytes !== undefined ? { memory: fmtMem(limits.memoryBytes) } : {}),
                  },
                },
              }
            : {}),
          ...(p.sleepSec !== null
            ? { labels: { 'swarmy.scaleToZero.enabled': 'true', 'swarmy.scaleToZero.idleSeconds': String(p.sleepSec) } }
            : {}),
        },
      },
    },
  };
  return [
    ...(git ? [{ label: 'swarmy.yaml', code: withHeader(`${git.configPath} @ ${git.branch} — ${p.name} as it runs now`, toYaml(yaml)) }] : []),
    { label: 'compose', code: withHeader(`${stack} — ${p.name}'s live deploy block`, toYaml(compose)) },
    { label: 'REST', code: scalingRest(p) },
  ];
}

/** Copies, size and sleep as the REST calls that set them to what runs now. */
function scalingRest(p: PickedCode): string {
  const id = p.inv.id;
  const replicas = p.inv.replicas.desired;
  const lines = ['# Copies', curl('POST', `/services/${id}/scale`, { replicas })];
  const l = p.limits;
  if (l?.cpus !== undefined || l?.memoryBytes !== undefined) {
    const limits = { ...(l.cpus !== undefined ? { cpus: l.cpus } : {}), ...(l.memoryBytes !== undefined ? { memory_bytes: l.memoryBytes } : {}) };
    lines.push('', '# Size per copy (reservations left out keep their live value)', curl('PATCH', `/services/${id}`, { resources: { limits } }));
  }
  lines.push('', '# Sleep: the labels the sleep switch writes (a PATCH is a deploy, so guardrails run)');
  lines.push(
    p.sleepSec !== null
      ? curl('PATCH', `/services/${id}`, {
          set_labels: {
            [SCALE_TO_ZERO_LABEL]: 'true',
            [SCALE_TO_ZERO_TARGET_LABEL]: p.inv.labels[SCALE_TO_ZERO_TARGET_LABEL] ?? String(Math.max(1, replicas)),
            [SCALE_TO_ZERO_IDLE_LABEL]: String(p.sleepSec),
          },
        })
      : curl('PATCH', `/services/${id}`, { remove_labels: [SCALE_TO_ZERO_LABEL, SCALE_TO_ZERO_TARGET_LABEL, SCALE_TO_ZERO_IDLE_LABEL] }),
  );
  return lines.join('\n');
}

/** Where these settings live, honestly: nothing here opens a pull request. */
export function scalingSourceNote(git: { configPath: string; enforceDrift: boolean } | null): string {
  const back = git?.enforceDrift ? 'the next drift check (every 10 minutes)' : 'the next push';
  return git
    ? `Lives in ${git.configPath}. Changing it here applies now; ${back} puts swarmy.yaml back. The same changes work over REST.`
    : 'Dashboard settings, applied to the live service. The same changes work over REST: copies, size and sleep.';
}
