/**
 * Is a preview asleep right now? — PURE, over the live inventory. A preview's
 * routed services carry the scale-to-zero labels (`previews.sleep_after`,
 * default 2 h); the idle sleeper scales them to 0 and the activator wakes
 * them on the next request. Asleep = every one of them is at 0 by design.
 */
import { PREVIEW_SLEEP_AFTER_SECONDS, type DesiredApp } from '@swarmy/app-config';
import { APP_STACK_LABEL } from './live';

interface LiveSvc {
  labels: Record<string, string>;
  scaleToZero: boolean;
  replicas: { desired: number; running: number };
}

/** 'asleep' / 'awake', or null when the preview has nothing that sleeps (or isn't running). */
export function previewSleepState(services: LiveSvc[], stack: string): 'asleep' | 'awake' | null {
  const sleepers = services.filter((s) => s.labels[APP_STACK_LABEL] === stack && s.scaleToZero);
  if (!sleepers.length) return null;
  return sleepers.every((s) => s.replicas.desired === 0 && s.replicas.running === 0) ? 'asleep' : 'awake';
}

/** The window the rules give new previews; a plan from before the setting existed reads as the default. */
export function rulesSleepSeconds(p: DesiredApp['previews']): number | null {
  return p.sleepAfterSeconds === undefined ? PREVIEW_SLEEP_AFTER_SECONDS : p.sleepAfterSeconds;
}
