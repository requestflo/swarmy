/**
 * Converge the `swarmy-mail` MTA onto the org's email config (the IO half of
 * maddy.ts). Called by the email reconcile worker and after every mutation
 * that changes the render (domain verified/removed, credential added/removed,
 * relay changed, suppression added).
 *
 * Idempotent: the render's signature rides on the service as a label; a
 * converged service is left alone. Secrets are content-addressed, created
 * before the deploy and swept after it.
 */
import { decryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../../context';
import { publicIpFromLabels } from '../node.service';
import { ensureControlNetwork } from '../platform-networks';
import { bounceHookPassword } from './keys';
import {
  BOUNCE_HOOK_HOST,
  BOUNCE_HOOK_PORT,
  BOUNCE_HOOK_USER,
  MAIL_NODE_LABEL,
  MAIL_SECRET_LABEL,
  MAIL_SERVICE,
  MAX_RENDERED_SUPPRESSIONS,
  maddyBundle,
  mailServiceSpec,
  staleMailSecrets,
  type MaddyDomain,
  type MaddyRelay,
  type MaddyUser,
} from './maddy';

export interface RelaySettings {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username?: string | null;
  spfInclude?: string | null;
}

export function relayOf(json: unknown): RelaySettings | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (typeof r.host !== 'string' || typeof r.port !== 'number') return null;
  const security = r.security === 'tls' || r.security === 'none' ? r.security : 'starttls';
  return {
    host: r.host,
    port: r.port,
    security,
    username: typeof r.username === 'string' ? r.username : null,
    spfInclude: typeof r.spfInclude === 'string' ? r.spfInclude : null,
  };
}

export function domainsOf(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((d): d is string => typeof d === 'string').map((d) => d.toLowerCase()) : [];
}

function tryDecrypt(blob: string | null | undefined): string | null {
  if (!blob) return null;
  try {
    return decryptSecret(blob);
  } catch {
    return null;
  }
}

/** Where the MTA runs / will run: its pin label when that node is known, else the manager's swarm node. */
export function mailPin(ctx: OrgContext): string | undefined {
  const live = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === MAIL_SERVICE);
  const known = new Set(ctx.hub.nodeInventory(ctx.activeOrgId, true).map((n) => n.swarmNodeId));
  const labelled = live?.labels[MAIL_NODE_LABEL];
  if (labelled && known.has(labelled)) return labelled;
  const mgr = ctx.hub.managerNode(ctx.activeOrgId);
  return (mgr && ctx.hub.swarmNodeIdFor(mgr)) || undefined;
}

/** The mail node's public IP(s) — SPF's `ip4:` on direct delivery. */
export function mailNodeIps(ctx: OrgContext): string[] {
  const pin = mailPin(ctx);
  if (!pin) return [];
  const node = ctx.hub.nodeInventory(ctx.activeOrgId, true).find((n) => n.swarmNodeId === pin);
  const ip = publicIpFromLabels(node?.labels);
  return ip ? [ip] : [];
}

/** Controller node id of the agent on the mail node (probe target). */
export function mailAgentNodeId(ctx: OrgContext): string | undefined {
  const pin = mailPin(ctx);
  const online = ctx.hub.onlineNodeIds();
  return online.find((id) => ctx.hub.swarmNodeIdFor(id) === pin) ?? ctx.hub.managerNode(ctx.activeOrgId);
}

/** HELO name: `mail.<system or first verified domain>`. */
export function heloHostFor(verified: Array<{ id: string; domain: string }>, systemDomainId: string | null | undefined): string {
  const d = verified.find((v) => v.id === systemDomainId) ?? verified[0];
  return d ? `mail.${d.domain}` : 'mail.swarmy.invalid';
}

export async function desiredMailBundle(ctx: OrgContext) {
  const db = ctx.db;
  const [config, domains, creds, supp] = await Promise.all([
    db.emailConfig.findUnique({ where: { orgId: ctx.activeOrgId } }),
    db.emailDomain.findMany({ where: { orgId: ctx.activeOrgId, verifiedAt: { not: null } }, orderBy: { domain: 'asc' } }),
    db.emailCredential.findMany({ where: { orgId: ctx.activeOrgId, disabled: false }, orderBy: { name: 'asc' } }),
    db.emailSuppression.findMany({
      where: { orgId: ctx.activeOrgId },
      orderBy: { createdAt: 'desc' },
      take: MAX_RENDERED_SUPPRESSIONS,
      select: { address: true },
    }),
  ]);
  const md: MaddyDomain[] = [];
  for (const d of domains) {
    const key = tryDecrypt(d.dkimPrivateKeyEnc);
    if (!key) continue;
    const relay = d.delivery === 'relay' ? relayOf(d.relay) : null;
    const mr: MaddyRelay | null = relay
      ? { host: relay.host, port: relay.port, security: relay.security, username: relay.username, password: tryDecrypt(d.relayPasswordEnc) }
      : null;
    md.push({ domain: d.domain, selector: d.selector, dkimPrivateKeyPem: key, relay: mr });
  }
  const verifiedNames = md.map((d) => d.domain);
  const users: MaddyUser[] = creds
    .map((c) => {
      const allowed = domainsOf(c.domains);
      return {
        username: c.smtpUsername,
        passwordHash: c.smtpPasswordHash,
        domains: allowed.length ? allowed.filter((d) => verifiedNames.includes(d)) : verifiedNames,
      };
    })
    .filter((u) => u.domains.length > 0);
  const bundle = maddyBundle({
    hostname: heloHostFor(domains, config?.systemDomainId),
    domains: md,
    users,
    suppressed: supp.map((s) => s.address),
    bounceHook: { host: BOUNCE_HOOK_HOST, port: BOUNCE_HOOK_PORT, username: BOUNCE_HOOK_USER, password: bounceHookPassword() },
  });
  return { enabled: Boolean(config?.enabled), bundle };
}

async function createSecret(ctx: OrgContext, nodeId: string, name: string, value: string): Promise<void> {
  try {
    await ctx.hub.dispatch(nodeId, 'secret.create', {
      name,
      dataB64: Buffer.from(value, 'utf8').toString('base64'),
      labels: { 'swarmy.managed': 'true', [MAIL_SECRET_LABEL]: 'true' },
    });
  } catch (e) {
    if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
}

async function sweepSecrets(ctx: OrgContext, nodeId: string, keep: string[]): Promise<void> {
  try {
    const res = await ctx.hub.dispatch<{ secrets?: Array<{ name: string }> }>(nodeId, 'secret.list', {});
    for (const name of staleMailSecrets((res.secrets ?? []).map((s) => s.name), keep)) {
      await ctx.hub.dispatch(nodeId, 'secret.remove', { name }).catch(() => undefined);
    }
  } catch {
    // best-effort; an in-use secret refuses removal and goes on the next converge.
  }
}

export type ConvergeOutcome = 'converged' | 'deployed' | 'removed' | 'off' | 'no-manager';

/** Bring the live MTA in line with the config. */
export async function convergeMail(ctx: OrgContext, opts: { force?: boolean } = {}): Promise<ConvergeOutcome> {
  const manager = ctx.hub.managerNode(ctx.activeOrgId);
  if (!manager) return 'no-manager';
  const live = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === MAIL_SERVICE);
  const { enabled, bundle } = await desiredMailBundle(ctx);
  if (!enabled) {
    if (!live) return 'off';
    await ctx.hub.dispatch(manager, 'service.remove', { service: MAIL_SERVICE }).catch(() => undefined);
    await sweepSecrets(ctx, manager, []);
    return 'removed';
  }
  if (!opts.force && live && live.labels['swarmy.email.signature'] === bundle.signature) return 'converged';
  for (const s of bundle.all) await createSecret(ctx, manager, s.name, s.value);
  await ensureControlNetwork(ctx, manager);
  await ctx.hub.dispatch(manager, 'service.deploy', { spec: mailServiceSpec({ bundle, pinSwarmNodeId: mailPin(ctx) }), pullPolicy: 'missing' });
  await sweepSecrets(ctx, manager, bundle.all.map((s) => s.name));
  return 'deployed';
}

/** Live MTA status for the UI (Docker truth). */
export function mailServiceStatus(ctx: OrgContext): { deployed: boolean; running: boolean; desired: number; image: string | null } {
  const live = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === MAIL_SERVICE);
  return {
    deployed: Boolean(live),
    running: (live?.runningReplicas ?? 0) > 0,
    desired: live?.desiredReplicas ?? 0,
    image: live?.image ?? null,
  };
}
