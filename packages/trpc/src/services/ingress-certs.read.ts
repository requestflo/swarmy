/**
 * Read the certificates every edge Caddy holds (board 30), by asking each
 * node that runs an edge task (`edge.certs`, read-only: the agent prints the
 * `.crt` files of the task's own storage and answers public facts only).
 *
 * The command reads in-task state no snapshot carries; certificates change
 * every few weeks, so it is asked on demand (the domain detail polls every
 * 30 s) and the answer is kept a minute per org in process memory, never a DB
 * row. Concurrent asks share one round. An agent that predates `edgeCerts` is
 * never sent it: that edge is "not reported", never an error.
 */
import { AGENT_CAPABILITY, EdgeCertsResult, agentSupports } from '@swarmy/core/protocol';
import type { EdgeCertRead } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { ingressTaskNodes } from './ingress-controller';

/** How long one round of reads answers the domain detail before it is asked again. */
export const EDGE_CERTS_TTL_MS = 60_000;
const READ_TIMEOUT_MS = 20_000;

const lastRound = new Map<string, { at: number; reads: EdgeCertRead[] }>();
const inflight = new Map<string, Promise<EdgeCertRead[]>>();

/** Forget an org's last round (after a renew, or in tests). */
export function forgetEdgeCerts(orgId?: string): void {
  if (orgId === undefined) lastRound.clear();
  else lastRound.delete(orgId);
}

/** One edge's answer, or null when no edge task runs there any more (it moved since the snapshot). */
async function readOne(ctx: OrgContext, nodeId: string): Promise<EdgeCertRead | null> {
  const build = ctx.hub.agentBuildFor?.(nodeId);
  if (!agentSupports(build?.capabilities, AGENT_CAPABILITY.edgeCerts)) {
    const which = build?.version ? `agent ${build.version}` : 'its agent';
    return { nodeId, status: 'not_reported', reason: `${which} predates the certificate read (update the agent to see it)` };
  }
  try {
    const raw = await ctx.hub.dispatch<unknown>(nodeId, 'edge.certs', {}, { timeoutMs: READ_TIMEOUT_MS });
    const parsed = EdgeCertsResult.safeParse(raw);
    if (!parsed.success) return { nodeId, status: 'error', reason: 'the agent answered with something unreadable' };
    if (!parsed.data.edge) return null;
    return { nodeId, status: 'read', certs: parsed.data.certs, checkedAt: parsed.data.checkedAt };
  } catch (e) {
    return { nodeId, status: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Every edge's read for the org (cached {@link EDGE_CERTS_TTL_MS}; `fresh` asks again). */
export async function readEdgeCertsAll(ctx: OrgContext, opts: { fresh?: boolean; now?: number } = {}): Promise<EdgeCertRead[]> {
  const orgId = ctx.activeOrgId;
  const now = opts.now ?? Date.now();
  const hit = lastRound.get(orgId);
  if (!opts.fresh && hit && now - hit.at < EDGE_CERTS_TTL_MS) return hit.reads;
  const pending = inflight.get(orgId);
  if (pending && !opts.fresh) return pending;
  const round = (async () => {
    const nodes = await ingressTaskNodes(ctx);
    const reads = (await Promise.all(nodes.map((n) => readOne(ctx, n)))).filter((r): r is EdgeCertRead => r !== null);
    lastRound.set(orgId, { at: opts.now ?? Date.now(), reads });
    return reads;
  })().finally(() => inflight.delete(orgId));
  inflight.set(orgId, round);
  return round;
}
