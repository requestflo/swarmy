/**
 * Port 25 on every server (board 66's per-server test). The workspace check
 * (`probePort25`) asks only the mail node; this asks every online server's
 * agent to open one TCP connection to a well-known MX on port 25 with a short
 * budget (no mail is sent) and says, per server, open / blocked / timeout in
 * plain words, so you know where direct delivery could work before moving
 * the mail server there.
 *
 * Only agents advertising the `probeSmtp` capability are asked. Results are
 * kept in controller memory (a fresh test is one click), never in the DB.
 */
import {
  AGENT_CAPABILITY,
  agentSupports,
  DEFAULT_SMTP_PROBE_TARGETS,
  port25ServerVerdict,
  type Port25State,
  type ProbeSmtpResult,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../../context';
import { writeAudit } from '../audit.service';

const TARGET = DEFAULT_SMTP_PROBE_TARGETS[0]!;
const PER_TARGET_MS = 5_000;

export interface ServerPort25View {
  nodeId: string;
  name: string;
  /** A verdict, or why there is none: untested, offline, an agent too old to ask. */
  state: Port25State | 'untested' | 'offline' | 'unsupported';
  words: string;
  /** "gmail-smtp-in.l.google.com:25" once tested. */
  target: string | null;
  /** How long the connection attempt took. */
  ms: number | null;
  at: number | null;
}

type Tested = Pick<ServerPort25View, 'state' | 'words' | 'target' | 'ms' | 'at'>;
const tested = new Map<string, Map<string, Tested>>();

/** Tests only. */
export function resetPort25Servers(): void {
  tested.clear();
}

function supports(ctx: OrgContext, nodeId: string): boolean {
  return agentSupports(ctx.hub.agentBuildFor?.(nodeId)?.capabilities, AGENT_CAPABILITY.probeSmtp);
}

function untested(ctx: OrgContext, nodeId: string): Tested {
  const none = { target: null, ms: null, at: null };
  if (!ctx.hub.isOnline(nodeId)) return { state: 'offline', words: 'Offline, so it can’t be tested.', ...none };
  if (!supports(ctx, nodeId)) return { state: 'unsupported', words: 'Its agent is too old to run the test; update it first.', ...none };
  return { state: 'untested', words: 'Not tested yet.', ...none };
}

async function probe(ctx: OrgContext, nodeId: string): Promise<Tested> {
  const target = `${TARGET.host}:${TARGET.port}`;
  try {
    const r = await ctx.hub.dispatch<ProbeSmtpResult>(nodeId, 'email.probeSmtp', { targets: [TARGET], perTargetMs: PER_TARGET_MS }, { timeoutMs: PER_TARGET_MS + 10_000 });
    return { ...port25ServerVerdict(r, PER_TARGET_MS), target, ms: r.attempts[0]?.ms ?? null, at: Date.now() };
  } catch (e) {
    return { state: 'unknown', words: `The agent didn’t answer the test: ${e instanceof Error ? e.message : String(e)}`, target, ms: null, at: Date.now() };
  }
}

/** Every enrolled server with its last result (or why it has none). */
export async function listPort25Servers(ctx: OrgContext): Promise<ServerPort25View[]> {
  const nodes = await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const mine = tested.get(ctx.activeOrgId);
  return nodes.map((n) => ({ nodeId: n.id, name: n.name, ...(mine?.get(n.id) ?? untested(ctx, n.id)) }));
}

/** Test every online server that can run it, in parallel; audited once. */
export async function testPort25Servers(ctx: OrgContext): Promise<ServerPort25View[]> {
  const nodes = await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true } });
  const askable = nodes.filter((n) => ctx.hub.isOnline(n.id) && supports(ctx, n.id));
  const results = await Promise.all(askable.map(async (n) => [n.id, await probe(ctx, n.id)] as const));
  const mine = tested.get(ctx.activeOrgId) ?? new Map<string, Tested>();
  for (const [id, r] of results) mine.set(id, r);
  tested.set(ctx.activeOrgId, mine);
  const count = (s: Port25State) => results.filter(([, r]) => r.state === s).length;
  await writeAudit(ctx, {
    action: 'email.port25.servers',
    targetType: 'email',
    metadata: { tested: results.length, open: count('open'), blocked: count('blocked'), timeout: count('timeout') },
  });
  return listPort25Servers(ctx);
}
