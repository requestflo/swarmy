/**
 * Email service reconcile worker (epic developer-platform §8).
 *
 * Every tick, for each org with the email service on:
 *   1. point the send log at the org's ClickHouse store (or memory),
 *   2. converge the `swarmy-mail` MTA onto the current render (signature
 *      label on the service; a converged MTA is left alone),
 *   3. re-check sending domains' DNS (unverified often, verified rarely) —
 *      the DKIM record flips the verification gate,
 *   4. probe outbound port 25 from the mail node now and then,
 *   5. keep one follow stream on the MTA's log, feeding the send log.
 * Results live in process memory (email/store.ts) — a restart re-derives them.
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import {
  checkEmailDomain,
  convergeMail,
  ingestMtaLogLines,
  MAIL_SERVICE,
  observabilityStore,
  port25Probe,
  probePort25,
  setEmailLogStore,
  domainCheck,
  systemContext,
} from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 30_000;
const UNVERIFIED_CHECK_MS = 60_000;
const VERIFIED_CHECK_MS = 30 * 60_000;
const PROBE_EVERY_MS = 6 * 3_600_000;

const followers = new Map<string, AbortController>();

/** Follow the MTA's log through a manager's agent; restarts on the next tick when it ends. */
function ensureLogFollower(orgId: string): void {
  if (followers.has(orgId)) return;
  const live = hub.liveInventory(orgId).services.find((s) => s.name === MAIL_SERVICE);
  const nodeId = hub.managerNode(orgId);
  if (!live || live.runningReplicas < 1 || !nodeId) return;
  const ac = new AbortController();
  followers.set(orgId, ac);
  void (async () => {
    let partial = '';
    try {
      for await (const chunk of hub.subscribeLogLines(
        nodeId,
        { action: 'start', target: { kind: 'service', service: MAIL_SERVICE }, tail: 0, follow: true },
        ac.signal,
      )) {
        const text = partial + chunk.message;
        const lines = text.split(/\r?\n/);
        partial = lines.pop() ?? '';
        if (lines.length) ingestMtaLogLines(orgId, lines);
      }
    } catch {
      // stream ended (MTA restarted, agent reconnected) — the next tick reopens it
    } finally {
      if (partial) ingestMtaLogLines(orgId, [partial]);
      followers.delete(orgId);
    }
  })();
}

async function tickOrg(orgId: string): Promise<void> {
  const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
  setEmailLogStore(orgId, await observabilityStore(ctx).catch(() => null));
  await convergeMail(ctx).catch(() => undefined);

  const now = Date.now();
  const domains = await prisma.emailDomain.findMany({ where: { orgId }, select: { id: true, verifiedAt: true, delivery: true } });
  for (const d of domains) {
    const last = domainCheck(d.id);
    const every = d.verifiedAt ? VERIFIED_CHECK_MS : UNVERIFIED_CHECK_MS;
    if (last && now - Date.parse(last.checkedAt) < every) continue;
    await checkEmailDomain(ctx, d.id).catch(() => undefined);
  }

  const probe = port25Probe(orgId);
  if (!probe || now - probe.at > PROBE_EVERY_MS) await probePort25(ctx).catch(() => undefined);

  ensureLogFollower(orgId);
}

async function tick(): Promise<void> {
  const orgs = await prisma.emailConfig.findMany({ where: { enabled: true }, select: { orgId: true } }).catch(() => []);
  const on = new Set(orgs.map((o) => o.orgId));
  for (const [orgId, ac] of followers) if (!on.has(orgId)) ac.abort();
  for (const { orgId } of orgs) await tickOrg(orgId).catch(() => undefined);
  // Orgs that just switched off: take the MTA down.
  const off = await prisma.emailConfig.findMany({ where: { enabled: false }, select: { orgId: true } }).catch(() => []);
  for (const { orgId } of off) {
    if (!hub.liveInventory(orgId).services.some((s) => s.name === MAIL_SERVICE)) continue;
    const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
    await convergeMail(ctx).catch(() => undefined);
  }
}

export function startEmailReconcile(): () => void {
  const first = setTimeout(() => void tick().catch(() => undefined), 5_000);
  const timer = setInterval(() => void tick().catch(() => undefined), TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    for (const ac of followers.values()) ac.abort();
  };
}
