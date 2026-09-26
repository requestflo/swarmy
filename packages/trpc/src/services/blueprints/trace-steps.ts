/**
 * PURE: a blueprint plan step → the traced deploy's stage and its plain log
 * lines. Only labels and the step's credential-free detail line are used —
 * never a token, a password or an env value.
 */
import type { DeployStage } from '@swarmy/core/protocol';
import type { BlueprintStepKind } from '@swarmy/core';

const DATA_KINDS = new Set<BlueprintStepKind>(['db.provision', 'cache.provision', 'bucket', 'secret']);

/** The tracker stage a step belongs to (the stack deploy itself is "start"). */
export function stepStage(kind: BlueprintStepKind): DeployStage {
  if (DATA_KINDS.has(kind)) return 'data';
  return kind === 'ingress.route' ? 'route' : 'start';
}

/** Controller-side data steps are traced by the controller; the rest by the agent + tail. */
export function tracesItself(kind: BlueprintStepKind): boolean {
  return DATA_KINDS.has(kind);
}

/** The done line: secrets say where the value went, the rest reuse the step's detail. */
export function stepDoneLine(kind: BlueprintStepKind, label: string, detail: string): string {
  if (kind === 'secret') {
    const what = label.replace(/^Generate secret /, 'secret ');
    return /reused/.test(detail) ? `${what} kept from an earlier deploy` : `${what} generated · stored as a Docker secret`;
  }
  return detail || label;
}

/** A stable key per step so the tracker can tell "all data steps done". */
export function stepKey(stack: string, kind: BlueprintStepKind, index: number): string {
  return `${stack}:${kind}:${index}`;
}
