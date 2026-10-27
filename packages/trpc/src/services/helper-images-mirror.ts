/**
 * Backup/restore/dump sidecars from the in-cluster mirror (air-gapped
 * clusters; wire shape in `@swarmy/core/protocol` `helper-pull.ts`).
 *
 * The hub decorator first fills each command's empty helper field with the
 * release's `<ref>@<digest>` (helper-images.ts). When the system-image mirror
 * is trusted, `rewriteSystemImages` then swaps every helper field holding an
 * exact system ref for its mirrored copy (tag kept) and keeps the upstream
 * ref in the matching fallback field, the shape `container.runOnce` has with
 * `fallbackImage`. The agent pulls the copy with the mirror login, then the
 * fallback. Only an agent that advertises `helperImageMirror` gets the
 * rewrite: an older one would pull the copy without a login, and the
 * registry refuses that.
 */
import {
  AGENT_CAPABILITY,
  HELPER_FALLBACK_FIELD,
  agentSupports,
  type HelperField,
} from '@swarmy/core/protocol';
import type { AgentHub, CommandName } from '../hub/types';

/**
 * Which payload fields name a helper image, per command. `appdb.verify`'s
 * `image` is the app's own engine (the scratch server), not a helper.
 */
export const HELPER_FIELDS: Readonly<Partial<Record<CommandName, readonly HelperField[]>>> = {
  'backup.run': ['image'],
  'backup.restore': ['image'],
  'backup.list': ['image'],
  'appdb.backup': ['resticImage'],
  'appdb.restore': ['resticImage'],
  'appdb.verify': ['resticImage'],
  'db.backup': ['resticImage', 'clientImage', 'engineImage'],
  'db.restore': ['resticImage', 'clientImage', 'engineImage'],
  'db.pitrWindow': ['engineImage'],
  'db.walVerify': ['engineImage'],
};

export function isHelperImageCommand(cmd: CommandName): boolean {
  return HELPER_FIELDS[cmd] !== undefined;
}

type Payload = Record<string, unknown> | null | undefined;

/** The helper images a backup/restore/dump dispatch makes the node pull. Pure. */
export function helperImagesOf(cmd: CommandName, payload: unknown): string[] {
  const p = payload as Payload;
  const out: string[] = [];
  for (const f of HELPER_FIELDS[cmd] ?? []) {
    const v = p?.[f];
    if (typeof v === 'string' && v) out.push(v);
  }
  return out;
}

/**
 * Swap each helper field for `toMirror(ref)` (null leaves it as it is) and
 * keep the ref it replaced as that field's fallback. A fallback the caller
 * set is never replaced. Same reference when nothing changes. Pure.
 */
export function mirrorHelperImages<P>(cmd: CommandName, payload: P, toMirror: (ref: string) => string | null): P {
  const p = payload as Payload;
  const fields = HELPER_FIELDS[cmd];
  if (!fields || !p || typeof p !== 'object') return payload;
  const add: Record<string, string> = {};
  for (const f of fields) {
    const cur = p[f];
    if (typeof cur !== 'string' || !cur) continue;
    const to = toMirror(cur);
    if (!to || to === cur) continue;
    add[f] = to;
    const fb = HELPER_FALLBACK_FIELD[f];
    if (typeof p[fb] !== 'string' || !p[fb]) add[fb] = cur;
  }
  return Object.keys(add).length ? ({ ...p, ...add } as P) : payload;
}

/** Does the agent on `nodeId` pull a mirrored helper with its login and fall back? Unknown node / older agent: no. */
export function agentTakesMirroredHelpers(hub: Pick<AgentHub, 'agentBuildFor'> | undefined, nodeId: string | undefined): boolean {
  if (!nodeId || !hub?.agentBuildFor) return false;
  return agentSupports(hub.agentBuildFor(nodeId)?.capabilities, AGENT_CAPABILITY.helperImageMirror);
}
