import type { BlueprintDeployResultView } from '@swarmy/core';

/**
 * The hand-off from a Deploy button to the app page's "Deploying → It's live"
 * state. Kept in memory on purpose: the blueprint result can carry one-time
 * secrets (`notes`), which must never land in the URL, history state or
 * storage. A reload loses them, exactly like the old inline result did.
 */
interface Handoff {
  /** The blueprint's step results (null for compose / image deploys). */
  result: BlueprintDeployResultView | null;
  /** When the deploy was sent, for the elapsed clock. */
  startedAt: number;
  /** The traced deploy's id (`deploys.events`), when the controller traced it. */
  deployId: string | null;
}

const handoffs = new Map<string, Handoff>();
const dismissed = new Set<string>();

/** Record a deploy that just went out; the app page picks it up. */
export function handDeploy(stack: string, result: BlueprintDeployResultView | null = null, deployId?: string): void {
  handoffs.set(stack, { result, startedAt: Date.now(), deployId: result?.deployId ?? deployId ?? null });
  dismissed.delete(stack);
}

/** The pending hand-off for this app, if a deploy was sent from this tab. */
export function deployHandoff(stack: string): Handoff | null {
  return handoffs.get(stack) ?? null;
}

/** The person has seen it live and moved on: a revisit shows the normal workspace. */
export function dismissDeploy(stack: string): void {
  dismissed.add(stack);
  handoffs.delete(stack);
}

export function isDeployDismissed(stack: string): boolean {
  return dismissed.has(stack);
}

/** Did the app itself go out? Only then is there an app page to watch. */
export function appWentOut(r: BlueprintDeployResultView): boolean {
  return r.steps.some((s) => s.kind === 'stack.deploy' && s.status === 'succeeded');
}

/**
 * The one exit for every template deploy (the gallery panel and the
 * Configure page): hand the result over and land on the app page's
 * "Deploying → It's live" state — one-time reveals included. Returns false
 * when the run stopped before the app existed, so the caller shows the steps.
 */
export function landOnDeployedApp(
  r: BlueprintDeployResultView,
  go: (to: { to: '/stacks/$name'; params: { name: string }; search: { deployed: number } }) => unknown,
): boolean {
  if (!appWentOut(r)) return false;
  handDeploy(r.stackName, r);
  void go({ to: '/stacks/$name', params: { name: r.stackName }, search: { deployed: 1 } });
  return true;
}
