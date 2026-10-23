import type { InvService } from '@swarmy/core';
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
 * from git, the live deploy block as compose, and the one REST route there
 * is (copies). Values are what runs now, not what the file says.
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
    { label: 'REST', code: curl('POST', `/services/${p.inv.id}/scale`, { replicas }) },
  ];
}

/** Where these settings live, honestly: nothing here opens a pull request. */
export function scalingSourceNote(git: { configPath: string; enforceDrift: boolean } | null): string {
  const back = git?.enforceDrift ? 'the next drift check (every 10 minutes)' : 'the next push';
  return git
    ? `Lives in ${git.configPath}. Changing it here applies now; ${back} puts swarmy.yaml back. Copies are also POST /api/v1/services/{id}/scale.`
    : 'Dashboard settings, applied to the live service. Copies are also POST /api/v1/services/{id}/scale; size and sleep have no REST route yet.';
}
