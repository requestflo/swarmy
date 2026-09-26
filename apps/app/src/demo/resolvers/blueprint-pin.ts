import type { BlueprintPlacementView, BlueprintPlanStepView } from '@swarmy/core';
import type { DemoStore } from '../types';

/**
 * The demo's "Pick a server" (mirrors blueprints/placement.ts): the node must
 * exist and be online, else the same plain error; a pinned plan's stack step
 * shows its `node.id==` constraint.
 */
export function demoPlacement(s: DemoStore, nodeId: string | undefined): BlueprintPlacementView | null {
  if (!nodeId) return null;
  const n = s.nodes.find((x) => x.id === nodeId);
  if (!n) throw new Error(`There's no server "${nodeId}" here. Pick another server, or Automatic.`);
  if (n.status !== 'online') throw new Error(`${n.name} is ${n.status}, so nothing can be placed on it. Pick another server, or Automatic.`);
  return { id: n.id, name: n.name, constraint: `node.id==${n.id}` };
}

/** The plan's steps with the stack pinned. */
export function pinDemoSteps(steps: BlueprintPlanStepView[], p: BlueprintPlacementView | null): BlueprintPlanStepView[] {
  if (!p) return steps;
  return steps.map((st) => (st.kind === 'stack.deploy' ? { ...st, detail: { ...st.detail, placement: p.constraint } } : st));
}

/** A template's notes, split the way the controller does: one-time secrets vs after-it's-live steps. */
export function splitDemoNotes(reveals: string[], postDeploy: string[], url: string | null): { notes: string[]; afterLive: string[] } {
  return { notes: reveals, afterLive: postDeploy.map((line) => line.replaceAll('<url>', url ?? 'the app URL')) };
}
